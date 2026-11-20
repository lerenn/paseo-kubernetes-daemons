package gateway

import (
	"context"
	"errors"
	"sync"
)

type pendingReply struct {
	operation string
	reply     chan Frame
}
type livePeer struct {
	backend *Backend
	target  Target
	mu      sync.Mutex
	pending map[string]pendingReply
	done    chan struct{}
	once    sync.Once
	onFrame func(Target, Frame) error
}

func newPeer(backend *Backend, target Target, onFrame func(Target, Frame) error) *livePeer {
	p := &livePeer{backend: backend, target: target, pending: make(map[string]pendingReply), done: make(chan struct{}), onFrame: onFrame}
	go p.read()
	return p
}

func (p *livePeer) close() { p.once.Do(func() { close(p.done); _ = p.backend.Close() }) }
func (p *livePeer) read() {
	defer p.close()
	for {
		frame, err := p.backend.Receive()
		if err != nil {
			return
		}
		if !frame.Binary {
			_, message, err := messageParts(frame)
			if err != nil {
				return
			}
			payload := objectValue(message, "payload")
			id := stringField(payload, "requestId")
			op := stringField(message, "type")
			if id != "" {
				p.mu.Lock()
				pending, ok := p.pending[id]
				if ok && (pending.operation == op || op == "rpc_error") {
					delete(p.pending, id)
				} else {
					ok = false
				}
				p.mu.Unlock()
				if ok {
					pending.reply <- frame
					continue
				}
			}
		}
		if err := p.onFrame(p.target, frame); err != nil {
			return
		}
	}
}

func (p *livePeer) call(ctx context.Context, frame Frame, responseType string) (Frame, error) {
	_, message, err := messageParts(frame)
	if err != nil {
		return Frame{}, err
	}
	id := stringField(message, "requestId")
	if id == "" {
		return Frame{}, errors.New("request ID required")
	}
	reply := pendingReply{operation: responseType, reply: make(chan Frame, 1)}
	p.mu.Lock()
	if _, exists := p.pending[id]; exists {
		p.mu.Unlock()
		return Frame{}, errors.New("duplicate request ID")
	}
	p.pending[id] = reply
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, id); p.mu.Unlock() }()
	if err := p.backend.Send(frame); err != nil {
		return Frame{}, err
	}
	select {
	case response := <-reply.reply:
		return response, nil
	case <-ctx.Done():
		return Frame{}, ctx.Err()
	case <-p.done:
		return Frame{}, errors.New("workspace daemon disconnected")
	}
}
