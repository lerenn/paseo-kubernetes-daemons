package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

type SessionOptions struct {
	ServerID, Hostname string
	BackendPassword    string
	Provisioner        *Provisioner
	Catalog            func(context.Context) ([]*Provisioner, error)
	Identity           ScopedIdentity
	Emit               func(Frame) error
	dialBackend        func(context.Context, string, string, string, []string, map[string]interface{}) (*Backend, error)
	waitReady          func(context.Context, string) (string, error)
}
type subscriptionRoute struct{ environment, upstream string }
type collectionState struct {
	frame  Frame
	routes []subscriptionRoute
}

// Session owns one client's workspace sockets and subscriptions. Its bounded
// input queue keeps slow provisioning from blocking other host-link channels.
type Session struct {
	options                SessionOptions
	ctx                    context.Context
	cancel                 context.CancelFunc
	input                  chan Frame
	mu                     sync.Mutex
	peers                  map[string]*livePeer
	publicSubs             map[string]subscriptionRoute
	upstreamSubs           map[string]string
	known                  map[string]map[string]bool
	collections            map[string]*collectionState
	workspaceSub, agentSub string
	eventsFrame            *Frame
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return "gw_" + hex.EncodeToString(b[:])
}

func NewSession(ctx context.Context, options SessionOptions) *Session {
	ctx, cancel := context.WithCancel(ctx)
	s := &Session{options: options, ctx: ctx, cancel: cancel, input: make(chan Frame, 64), peers: map[string]*livePeer{}, publicSubs: map[string]subscriptionRoute{}, upstreamSubs: map[string]string{}, known: map[string]map[string]bool{}, collections: map[string]*collectionState{}}
	go s.run()
	return s
}
func (s *Session) Enqueue(frame Frame) error {
	if len(frame.Data) > maxLinkFrameBytes {
		return errors.New("session frame exceeds limit")
	}
	select {
	case <-s.ctx.Done():
		return s.ctx.Err()
	case s.input <- frame:
		return nil
	default:
		return errors.New("workspace session request queue is full")
	}
}
func (s *Session) Close() {
	s.cancel()
	s.mu.Lock()
	peers := make([]*livePeer, 0, len(s.peers))
	for _, p := range s.peers {
		peers = append(peers, p)
	}
	s.peers = map[string]*livePeer{}
	s.mu.Unlock()
	for _, p := range peers {
		p.close()
	}
}
func (s *Session) emit(frame Frame) error {
	if s.ctx.Err() != nil {
		return s.ctx.Err()
	}
	if err := s.options.Emit(frame); err != nil {
		s.cancel()
		return err
	}
	return nil
}
func (s *Session) run() {
	defer s.Close()
	for {
		select {
		case <-s.ctx.Done():
			return
		case frame := <-s.input:
			if err := s.handle(frame); err != nil {
				_ = s.emit(responseError(frame, err))
			}
		}
	}
}

func (s *Session) catalog() ([]*Provisioner, error) {
	if s.options.Catalog != nil {
		return s.options.Catalog(s.ctx)
	}
	if s.options.Provisioner == nil {
		return nil, errors.New("gateway is not configured")
	}
	return []*Provisioner{s.options.Provisioner}, nil
}
func (s *Session) discovery(projectID string) (*Provisioner, Discovery, error) {
	catalog, err := s.catalog()
	if err != nil {
		return nil, Discovery{}, err
	}
	for _, p := range catalog {
		d, err := p.Discover(s.ctx)
		if err != nil {
			return nil, Discovery{}, err
		}
		if projectID == "" || d.Project != nil && (d.Project.ID == projectID || d.Project.Root == projectID) {
			return p, d, nil
		}
	}
	return nil, Discovery{}, errors.New("project credentials have not been synced")
}

func (s *Session) handle(frame Frame) error {
	if frame.Binary {
		return errors.New("binary uploads require a workspace-scoped transfer")
	}
	envelope, message, err := messageParts(frame)
	if err != nil {
		return err
	}
	op, id := stringField(message, "type"), stringField(message, "requestId")
	if err := AuthorizeOperation(s.options.Identity.Permissions, op); err != nil && op != "subscription.release.request" {
		return err
	}
	switch op {
	case "provider.controls.list.request", "list_provider_features_request":
		if _, _, err := ParseVirtualPath(stringField(objectValue(message, "draftConfig"), "cwd")); err != nil {
			return s.hostRequest(frame)
		}
	case "ping":
		f, _ := sessionFrame(map[string]interface{}{"type": "pong", "payload": map[string]interface{}{"requestId": id, "serverReceivedAt": time.Now().UnixMilli(), "serverSentAt": time.Now().UnixMilli()}})
		return s.emit(f)
	case "project.list.request", "get_providers_snapshot_request", "list_available_providers_request", "list_provider_models_request", "list_provider_modes_request", "get_daemon_config_request", "hosts.list.request":
		return s.hostRequest(frame)
	case "workspace.create.request":
		return s.create(frame)
	case "fetch_workspaces_request", "fetch_agents_request", "fetch_agent_history_request":
		return s.directory(frame)
	case "session.events.set_subscription.request":
		s.mu.Lock()
		copy := frame
		s.eventsFrame = &copy
		peers := make([]*livePeer, 0, len(s.peers))
		for _, p := range s.peers {
			peers = append(peers, p)
		}
		s.mu.Unlock()
		for _, p := range peers {
			e, m, _ := messageParts(frame)
			setString(m, "requestId", randomID())
			if err := p.backend.Send(encodeMessage(e, m)); err != nil {
				return err
			}
		}
		f, _ := sessionFrame(map[string]interface{}{"type": "session.events.set_subscription.response", "payload": map[string]interface{}{"requestId": id}})
		return s.emit(f)
	case "client_heartbeat":
		s.mu.Lock()
		peers := make([]*livePeer, 0, len(s.peers))
		for _, p := range s.peers {
			peers = append(peers, p)
		}
		s.mu.Unlock()
		for _, p := range peers {
			if err := p.backend.Send(frame); err != nil {
				return err
			}
		}
		return nil
	case "agent.timeline.set_subscription.request":
		return s.timeline(frame)
	case "subscription.release.request":
		public := stringField(message, "subscriptionId")
		s.mu.Lock()
		collection, grouped := s.collections[public]
		if grouped {
			delete(s.collections, public)
		}
		sub, ok := s.publicSubs[public]
		s.mu.Unlock()
		if grouped {
			for _, item := range collection.routes {
				peer, err := s.peer(item.environment)
				if err != nil {
					continue
				}
				e, m, _ := messageParts(frame)
				setString(m, "subscriptionId", item.upstream)
				setString(m, "requestId", randomID())
				ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
				_, _ = peer.call(ctx, encodeMessage(e, m), "subscription.release.response")
				cancel()
			}
			f, _ := sessionFrame(map[string]interface{}{"type": "subscription.release.response", "payload": map[string]string{"requestId": id, "subscriptionId": public}})
			return s.emit(f)
		}
		if !ok {
			return errors.New("subscription is not owned by this session")
		}
		peer, err := s.peer(sub.environment)
		if err != nil {
			return err
		}
		setString(message, "subscriptionId", sub.upstream)
		return peer.backend.Send(encodeMessage(envelope, message))
	case "creation.subscribe.request":
		// Returning no snapshot asks the SDK to resubmit its original intent.
		// Kubernetes and the workspace daemon both preserve its idempotency key.
		f, _ := sessionFrame(map[string]interface{}{"type": "creation.subscribe.response", "payload": map[string]interface{}{"requestId": id, "snapshot": nil, "error": nil}})
		return s.emit(f)
	}
	name, err := s.route(message)
	if err != nil {
		return err
	}
	peer, err := s.peer(name)
	if err != nil {
		return err
	}
	if op == "archive_workspace_request" {
		return s.archive(frame, peer)
	}
	if raw, ok := message["subscriptionId"]; ok && string(raw) != "null" {
		public := stringField(message, "subscriptionId")
		s.mu.Lock()
		sub, known := s.publicSubs[public]
		s.mu.Unlock()
		if known {
			if sub.environment != name {
				return errors.New("subscription belongs to another workspace")
			}
			setString(message, "subscriptionId", sub.upstream)
		} else {
			upstream := randomID()
			s.mu.Lock()
			s.publicSubs[public] = subscriptionRoute{name, upstream}
			s.upstreamSubs[name+"/"+upstream] = public
			s.mu.Unlock()
			setString(message, "subscriptionId", upstream)
		}
	}
	return peer.backend.Send(encodeMessage(envelope, message))
}

func (s *Session) route(message wireObject) (string, error) {
	var selected string
	choose := func(name string) error {
		if selected != "" && selected != name {
			return errors.New("request spans multiple workspace pods")
		}
		selected = name
		return nil
	}
	for _, object := range []wireObject{message, objectValue(message, "config"), objectValue(message, "draftConfig")} {
		if cwd := stringField(object, "cwd"); cwd != "" {
			name, _, err := ParseVirtualPath(cwd)
			if err != nil {
				return "", err
			}
			if err := choose(name); err != nil {
				return "", err
			}
		}
	}
	for field, kind := range map[string]string{"workspaceId": "workspace", "agentId": "agent", "parentAgentId": "agent", "terminalId": "terminal"} {
		if stringField(message, "type") == "agent.create.request" && field == "agentId" {
			continue
		}
		id := stringField(message, field)
		if id == "" {
			continue
		}
		endpoint, err := s.options.Provisioner.Resolve(s.ctx, kind, id)
		if err != nil {
			return "", err
		}
		name := strings.TrimSuffix(strings.TrimPrefix(endpoint, "pw-"), "."+s.options.Provisioner.Namespace+".svc:6767")
		if err := choose(name); err != nil {
			return "", err
		}
	}
	if selected == "" {
		if public := stringField(message, "subscriptionId"); public != "" {
			s.mu.Lock()
			sub, ok := s.publicSubs[public]
			s.mu.Unlock()
			if ok {
				selected = sub.environment
			}
		}
	}
	if selected == "" {
		return "", routingError()
	}
	return selected, nil
}

func (s *Session) peer(name string) (*livePeer, error) {
	s.mu.Lock()
	existing := s.peers[name]
	s.mu.Unlock()
	if existing != nil {
		select {
		case <-existing.done:
			s.mu.Lock()
			delete(s.peers, name)
			s.mu.Unlock()
		default:
			return existing, nil
		}
	}
	targets, err := s.options.Provisioner.Targets(s.ctx)
	if err != nil {
		return nil, err
	}
	for _, target := range targets {
		if target.Name != name {
			continue
		}
		dial := s.options.dialBackend
		if dial == nil {
			dial = DialScopedBackend
		}
		backend, err := dial(s.ctx, target.Endpoint, s.options.Identity.ClientID+"-"+randomID(), s.options.BackendPassword, s.options.Identity.Permissions, s.options.Identity.Capabilities)
		if err != nil {
			return nil, err
		}
		return s.adopt(backend, target), nil
	}
	return nil, errors.New("workspace daemon is unavailable or was replaced")
}
func (s *Session) adopt(backend *Backend, target Target) *livePeer {
	p := newPeer(backend, target, s.deliver)
	s.mu.Lock()
	old := s.peers[target.Name]
	s.peers[target.Name] = p
	events := s.eventsFrame
	s.mu.Unlock()
	if old != nil {
		old.close()
	}
	if events != nil {
		e, m, _ := messageParts(*events)
		setString(m, "requestId", randomID())
		_ = backend.Send(encodeMessage(e, m))
	}
	return p
}

func (s *Session) deliver(target Target, frame Frame) error {
	if !frame.Binary {
		envelope, message, err := messageParts(frame)
		if err != nil {
			return err
		}
		payload := objectValue(message, "payload")
		op := stringField(message, "type")
		if op == "session.events.set_subscription.response" {
			return nil
		}
		if err := s.learn(target, payload); err != nil {
			return err
		}
		if payload != nil {
			if upstream := stringField(payload, "subscriptionId"); upstream != "" {
				key := target.Name + "/" + upstream
				s.mu.Lock()
				public := s.upstreamSubs[key]
				if public == "" {
					public = randomID()
					s.upstreamSubs[key] = public
					s.publicSubs[public] = subscriptionRoute{target.Name, upstream}
				}
				s.mu.Unlock()
				setString(payload, "subscriptionId", public)
			}
			delete(payload, "generation")
			delete(payload, "seq")
			data, _ := json.Marshal(payload)
			message["payload"] = data
			frame = encodeMessage(envelope, message)
		}
	}
	translated, err := TranslateBackendFrame(frame, target)
	if err != nil {
		return err
	}
	return s.emit(translated)
}

func (s *Session) learn(target Target, payload wireObject) error {
	if payload == nil {
		return nil
	}
	seen := Routes{PodUID: target.PodUID, Workspace: target.Routes.Workspace}
	agent := objectValue(payload, "agent")
	if id := stringField(agent, "id"); id != "" {
		if workspace := stringField(agent, "workspaceId"); workspace != "" && workspace != seen.Workspace {
			return errors.New("backend agent belongs to another workspace")
		}
		seen.Agents = append(seen.Agents, id)
	}
	terminal := objectValue(payload, "terminal")
	if id := stringField(terminal, "id"); id != "" {
		seen.Terminals = append(seen.Terminals, id)
	}
	for _, key := range []string{"terminals", "agents", "entries"} {
		var entries []wireObject
		if json.Unmarshal(payload[key], &entries) != nil {
			continue
		}
		for _, entry := range entries {
			if key == "entries" {
				entry = objectValue(entry, "agent")
			}
			id := stringField(entry, "id")
			if id == "" {
				continue
			}
			if key == "terminals" {
				seen.Terminals = append(seen.Terminals, id)
			} else {
				seen.Agents = append(seen.Agents, id)
			}
		}
	}
	if len(seen.Agents)+len(seen.Terminals) == 0 {
		return nil
	}
	// Avoid a Kubernetes write for every status/timeline update.
	s.mu.Lock()
	known := s.known[target.Name]
	if known == nil {
		known = map[string]bool{}
		s.known[target.Name] = known
		for _, id := range append(append([]string{}, target.Routes.Agents...), target.Routes.Terminals...) {
			known[id] = true
		}
	}
	fresh := false
	for _, id := range append(append([]string{}, seen.Agents...), seen.Terminals...) {
		if !known[id] {
			fresh = true
			known[id] = true
		}
	}
	s.mu.Unlock()
	if !fresh {
		return nil
	}
	return s.options.Provisioner.SaveRoutes(s.ctx, target.Name, seen)
}

func (s *Session) create(frame Frame) error {
	_, message, _ := messageParts(frame)
	source := objectValue(message, "source")
	project := stringField(source, "projectId")
	if project == "" {
		project = stringField(source, "path")
		if project == "" {
			project = stringField(source, "cwd")
		}
	}
	p, _, err := s.discovery(project)
	if err != nil {
		return err
	}
	creator := Creator{Provisioner: p, ClientID: s.options.Identity.ClientID + "-" + randomID(), Password: s.options.BackendPassword, Wait: s.options.waitReady, Dial: func(ctx context.Context, endpoint, client, password string) (WorkspaceBackend, error) {
		dial := s.options.dialBackend
		if dial == nil {
			dial = DialScopedBackend
		}
		return dial(ctx, endpoint, client, password, s.options.Identity.Permissions, s.options.Identity.Capabilities)
	}}
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Minute)
	defer cancel()
	result, err := creator.Create(ctx, frame)
	if err != nil {
		return err
	}
	if result.Backend == nil {
		return s.emit(result.Response)
	}
	backend, ok := result.Backend.(*Backend)
	if !ok {
		_ = result.Backend.Close()
		return errors.New("unexpected workspace transport")
	}
	targets, err := p.Targets(s.ctx)
	if err != nil {
		backend.Close()
		return err
	}
	var target *Target
	for i := range targets {
		if targets[i].Name == result.Environment {
			target = &targets[i]
			break
		}
	}
	if target == nil {
		backend.Close()
		return errors.New("new workspace routes are unavailable")
	}
	for _, event := range result.Events {
		if err := s.deliver(*target, event); err != nil {
			backend.Close()
			return err
		}
	}
	if err := s.deliver(*target, result.Response); err != nil {
		backend.Close()
		return err
	}
	s.adopt(backend, *target)
	return nil
}

func (s *Session) timeline(frame Frame) error {
	_, message, _ := messageParts(frame)
	var ids []string
	_ = json.Unmarshal(message["agentIds"], &ids)
	grouped := map[string][]string{}
	for _, id := range ids {
		request := wireObject{}
		setString(request, "agentId", id)
		name, err := s.route(request)
		if err != nil {
			return err
		}
		grouped[name] = append(grouped[name], id)
	}
	s.mu.Lock()
	for name := range s.peers {
		if _, ok := grouped[name]; !ok {
			grouped[name] = []string{}
		}
	}
	s.mu.Unlock()
	for name, agents := range grouped {
		peer, err := s.peer(name)
		if err != nil {
			return err
		}
		e, m, _ := messageParts(frame)
		data, _ := json.Marshal(agents)
		m["agentIds"] = data
		setString(m, "requestId", randomID())
		ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
		_, err = peer.call(ctx, encodeMessage(e, m), "agent.timeline.set_subscription.response")
		cancel()
		if err != nil {
			return err
		}
	}
	response, _ := sessionFrame(map[string]interface{}{"type": "agent.timeline.set_subscription.response", "payload": map[string]interface{}{"requestId": stringField(message, "requestId"), "agentIds": ids}})
	return s.emit(response)
}

func (s *Session) archive(frame Frame, peer *livePeer) error {
	_, message, _ := messageParts(frame)
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	response, err := peer.call(ctx, frame, "archive_workspace_response")
	if err != nil {
		return err
	}
	_, reply, _ := messageParts(response)
	payload := objectValue(reply, "payload")
	success := string(payload["error"]) == "null" && stringField(payload, "archivedAt") != ""
	_ = message
	if err := s.deliver(peer.target, response); err != nil {
		return err
	}
	if success {
		return s.deleteEnvironment(peer.target.Name)
	}
	return nil
}
