package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strconv"
	"time"
)

type directoryCursor struct {
	Offset int    `json:"offset"`
	Digest string `json:"digest"`
}

func (s *Session) directory(frame Frame) error {
	_, message, _ := messageParts(frame)
	op, id := stringField(message, "type"), stringField(message, "requestId")
	targets, err := s.options.Provisioner.Targets(s.ctx)
	if err != nil {
		return err
	}
	var rows []wireObject
	filter := objectValue(message, "filter")
	projectID := stringField(filter, "projectId")
	public := ""
	subscribe := objectValue(message, "subscribe")
	if subscribe != nil {
		public = stringField(subscribe, "subscriptionId")
		if public == "" {
			public = randomID()
		}
		s.mu.Lock()
		s.collections[public] = &collectionState{frame: frame}
		s.mu.Unlock()
	}
	for _, target := range targets {
		if projectID != "" && target.Project.ID != projectID {
			continue
		}
		peer, err := s.peer(target.Name)
		if err != nil {
			return err
		}
		entries, err := s.directoryPeer(frame, peer, public)
		if err != nil {
			return err
		}
		rows = append(rows, entries...)
		if len(rows) > 10000 {
			return errors.New("workspace directory exceeds the gateway result limit")
		}
	}
	// A stable global ordering and a digest-bound cursor prevent a cursor from
	// one pod being accidentally reused against another pod's directory.
	var order []struct {
		Key       string `json:"key"`
		Direction string `json:"direction"`
	}
	_ = json.Unmarshal(message["sort"], &order)
	if len(order) == 0 {
		if op == "fetch_workspaces_request" {
			order = append(order, struct {
				Key       string `json:"key"`
				Direction string `json:"direction"`
			}{"activity_at", "desc"})
		} else {
			order = append(order, struct {
				Key       string `json:"key"`
				Direction string `json:"direction"`
			}{"created_at", "desc"})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		for _, item := range order {
			a, b := directorySortValue(rows[i], item.Key), directorySortValue(rows[j], item.Key)
			if a == b {
				continue
			}
			if item.Direction == "desc" {
				return a > b
			}
			return a < b
		}
		return directoryRowID(rows[i]) < directoryRowID(rows[j])
	})
	fingerprint := sha256.New()
	fingerprint.Write(message["filter"])
	fingerprint.Write(message["sort"])
	for _, row := range rows {
		fingerprint.Write([]byte(directoryRowID(row)))
		fingerprint.Write([]byte{0})
	}
	digest := hex.EncodeToString(fingerprint.Sum(nil))
	page := objectValue(message, "page")
	limit := 200
	_ = json.Unmarshal(page["limit"], &limit)
	if limit < 1 || limit > 200 {
		limit = 200
	}
	offset := 0
	if cursor := stringField(page, "cursor"); cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		var value directoryCursor
		if err != nil || json.Unmarshal(raw, &value) != nil || value.Digest != digest || value.Offset < 0 || value.Offset > len(rows) {
			return errors.New("directory changed; reload from the first page")
		}
		offset = value.Offset
	}
	end := min(offset+limit, len(rows))
	cursorAt := func(index int) interface{} {
		if index < 0 || index >= len(rows) {
			return nil
		}
		raw, _ := json.Marshal(directoryCursor{Offset: index, Digest: digest})
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	result := rows[offset:end]
	if result == nil {
		result = []wireObject{}
	}
	payload := map[string]interface{}{"requestId": id, "entries": result, "pageInfo": map[string]interface{}{"hasMore": end < len(rows), "nextCursor": cursorAt(end), "prevCursor": nil}}
	if offset > 0 {
		payload["pageInfo"].(map[string]interface{})["prevCursor"] = cursorAt(max(0, offset-limit))
	}
	if public != "" {
		payload["subscriptionId"] = public
	}
	response := "fetch_agents_response"
	if op == "fetch_workspaces_request" {
		response = "fetch_workspaces_response"
		empty := []interface{}{}
		catalog, err := s.catalog()
		if err != nil {
			return err
		}
		for _, p := range catalog {
			d, err := p.Discover(s.ctx)
			if err != nil {
				slog.Warn("skipping unavailable project profile", "profile", p.Profile, "reason", err.Error())
				continue
			}
			if d.Project == nil {
				continue
			}
			has := false
			for _, row := range rows {
				if stringField(row, "projectId") == d.Project.ID {
					has = true
					break
				}
			}
			if !has {
				empty = append(empty, map[string]interface{}{"projectId": d.Project.ID, "projectDisplayName": d.Project.Name, "projectRootPath": d.Project.Root, "projectKind": "git"})
			}
		}
		payload["emptyProjects"] = empty
	} else if op == "fetch_agent_history_request" {
		response = "fetch_agent_history_response"
	}
	out, err := sessionFrame(map[string]interface{}{"type": response, "payload": payload})
	if err != nil {
		return err
	}
	return s.emit(out)
}

func (s *Session) directoryPeer(frame Frame, peer *livePeer, public string) ([]wireObject, error) {
	_, original, _ := messageParts(frame)
	op := stringField(original, "type")
	response := "fetch_agents_response"
	if op == "fetch_workspaces_request" {
		response = "fetch_workspaces_response"
	} else if op == "fetch_agent_history_request" {
		response = "fetch_agent_history_response"
	}
	var rows []wireObject
	cursor := ""
	first := true
	for {
		envelope, message, _ := messageParts(frame)
		setString(message, "requestId", randomID())
		delete(message, "sync")
		delete(message, "subscribe")
		filter := objectValue(message, "filter")
		if filter != nil {
			delete(filter, "projectId")
			raw, _ := json.Marshal(filter)
			message["filter"] = raw
		}
		page := map[string]interface{}{"limit": 200}
		if cursor != "" {
			page["cursor"] = cursor
		}
		raw, _ := json.Marshal(page)
		message["page"] = raw
		upstream := ""
		if first && public != "" {
			upstream = randomID()
			raw, _ := json.Marshal(map[string]string{"subscriptionId": upstream})
			message["subscribe"] = raw
			s.mu.Lock()
			s.upstreamSubs[peer.target.Name+"/"+upstream] = public
			s.mu.Unlock()
		}
		ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
		reply, err := peer.call(ctx, encodeMessage(envelope, message), response)
		cancel()
		if err != nil {
			return nil, err
		}
		_, replyMsg, _ := messageParts(reply)
		if stringField(replyMsg, "type") == "rpc_error" {
			return nil, errors.New("workspace daemon rejected directory query")
		}
		payload := objectValue(replyMsg, "payload")
		if actual := stringField(payload, "subscriptionId"); actual != "" && public != "" {
			s.mu.Lock()
			s.upstreamSubs[peer.target.Name+"/"+actual] = public
			if collection := s.collections[public]; collection != nil {
				collection.routes = append(collection.routes, subscriptionRoute{peer.target.Name, actual})
			}
			s.mu.Unlock()
		}
		if err := s.learn(peer.target, payload); err != nil {
			return nil, err
		}
		translated, err := TranslateBackendFrame(reply, peer.target)
		if err != nil {
			return nil, err
		}
		_, replyMsg, _ = messageParts(translated)
		payload = objectValue(replyMsg, "payload")
		var entries []wireObject
		if json.Unmarshal(payload["entries"], &entries) != nil {
			return nil, errors.New("invalid workspace directory response")
		}
		rows = append(rows, entries...)
		if len(rows) > 10000 {
			return nil, errors.New("workspace directory result exceeds limit")
		}
		info := objectValue(payload, "pageInfo")
		cursor = stringField(info, "nextCursor")
		var more bool
		_ = json.Unmarshal(info["hasMore"], &more)
		if !more {
			return rows, nil
		}
		if cursor == "" {
			return nil, errors.New("workspace daemon omitted its directory cursor")
		}
		first = false
	}
}

func directoryRowID(row wireObject) string {
	if agent := objectValue(row, "agent"); agent != nil {
		return stringField(agent, "id")
	}
	return stringField(row, "id")
}
func directorySortValue(row wireObject, key string) string {
	if agent := objectValue(row, "agent"); agent != nil {
		row = agent
	}
	switch key {
	case "activity_at":
		return stringField(row, "activityAt")
	case "created_at":
		return stringField(row, "createdAt")
	case "updated_at":
		return stringField(row, "updatedAt")
	case "title":
		return stringField(row, "title")
	case "name":
		return stringField(row, "name")
	case "project_id":
		return stringField(row, "projectId")
	case "status_priority":
		ranks := map[string]int{"running": 0, "pending_attention": 1, "idle": 2, "done": 3, "error": 4}
		return strconv.Itoa(ranks[stringField(row, "status")])
	}
	return ""
}
