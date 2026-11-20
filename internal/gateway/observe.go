package gateway

import (
	"context"
	"encoding/json"
	"errors"
)

// ObserveCreation records identities returned by the corresponding pod daemon.
// It must only be called for the response to the gateway's own creation
// request, after checking its request ID and backend connection identity.
func (p *Provisioner) ObserveCreation(ctx context.Context, name, podUID, requestID string, frame []byte) error {
	var env struct {
		Type    string `json:"type"`
		Message struct {
			Type    string `json:"type"`
			Payload struct {
				RequestID string  `json:"requestId"`
				Error     *string `json:"error"`
				Workspace *struct {
					ID string `json:"id"`
				} `json:"workspace"`
				Agent *struct {
					ID          string `json:"id"`
					WorkspaceID string `json:"workspaceId"`
				} `json:"agent"`
				SetupTerminalID *string `json:"setupTerminalId"`
			} `json:"payload"`
		} `json:"message"`
	}
	if json.Unmarshal(frame, &env) != nil || env.Type != "session" || env.Message.Type != "workspace.create.response" || requestID == "" || env.Message.Payload.RequestID != requestID {
		return errors.New("unexpected workspace creation response")
	}
	payload := env.Message.Payload
	if payload.Error != nil {
		return errors.New("workspace daemon rejected creation")
	}
	if payload.Workspace == nil || !validRouteID(payload.Workspace.ID) {
		return errors.New("creation response has no workspace identity")
	}
	routes := Routes{PodUID: podUID, Workspace: payload.Workspace.ID}
	if payload.Agent != nil {
		if !validRouteID(payload.Agent.ID) || (payload.Agent.WorkspaceID != "" && payload.Agent.WorkspaceID != routes.Workspace) {
			return errors.New("creation response agent belongs to another workspace")
		}
		routes.Agents = []string{payload.Agent.ID}
	}
	if payload.SetupTerminalID != nil {
		routes.Terminals = []string{*payload.SetupTerminalID}
	}
	return p.SaveRoutes(ctx, name, routes)
}
