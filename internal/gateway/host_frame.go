package gateway

import (
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

const hostRouteOpcode byte = 0x30
const maxHostRouteIDBytes = 256
const maxRoutedPayloadBytes = 32*1024*1024 - (3 + maxHostRouteIDBytes)

// EncodeHostFrame wraps a binary terminal/file payload for a host-link route.
func EncodeHostFrame(routeID string, payload []byte) ([]byte, error) {
	id := []byte(routeID)
	if len(id) == 0 || len(id) > maxHostRouteIDBytes || !utf8.Valid(id) {
		return nil, errors.New("invalid host route ID")
	}
	if len(payload) > maxRoutedPayloadBytes {
		return nil, errors.New("host payload too large")
	}
	frame := make([]byte, 3+len(id)+len(payload))
	frame[0] = hostRouteOpcode
	binary.BigEndian.PutUint16(frame[1:3], uint16(len(id)))
	copy(frame[3:], id)
	copy(frame[3+len(id):], payload)
	return frame, nil
}

func DecodeHostFrame(frame []byte) (string, []byte, error) {
	if len(frame) < 3 || frame[0] != hostRouteOpcode {
		return "", nil, errors.New("invalid host route frame")
	}
	length := int(binary.BigEndian.Uint16(frame[1:3]))
	if length == 0 || length > maxHostRouteIDBytes || len(frame) < 3+length || len(frame)-3-length > maxRoutedPayloadBytes || !utf8.Valid(frame[3:3+length]) {
		return "", nil, errors.New("invalid host route frame")
	}
	return string(frame[3 : 3+length]), frame[3+length:], nil
}
