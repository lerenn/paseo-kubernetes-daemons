package gateway

import (
	"encoding/json"
	"errors"
)

type wireObject map[string]json.RawMessage

func objectField(parent wireObject, key string, apply func(wireObject) error) error {
	raw, ok := parent[key]
	if !ok || string(raw) == "null" {
		return nil
	}
	var child wireObject
	if json.Unmarshal(raw, &child) != nil || child == nil {
		return errors.New("invalid response object")
	}
	if err := apply(child); err != nil {
		return err
	}
	encoded, err := json.Marshal(child)
	if err == nil {
		parent[key] = encoded
	}
	return err
}

func setString(object wireObject, key, value string) {
	encoded, _ := json.Marshal(value)
	object[key] = encoded
}

func virtualField(object wireObject, key, environment string) error {
	raw, ok := object[key]
	if !ok || string(raw) == "null" {
		return nil
	}
	var real string
	if json.Unmarshal(raw, &real) != nil {
		return errors.New("invalid response path")
	}
	if env, _, err := ParseVirtualPath(real); err == nil {
		if env != environment {
			return errors.New("response path belongs to another workspace")
		}
		return nil
	}
	virtual, err := VirtualizePath(environment, real)
	if err != nil {
		return err
	}
	setString(object, key, virtual)
	return nil
}

// TranslateCreationFrame changes only known path and project fields. User
// messages, labels and arbitrary model metadata remain untouched.
func TranslateCreationFrame(frame Frame, environment string, project Project) (Frame, error) {
	if frame.Binary {
		return Frame{}, errors.New("unexpected binary creation frame")
	}
	var env wireObject
	if json.Unmarshal(frame.Data, &env) != nil {
		return Frame{}, errors.New("invalid session response")
	}
	var typ string
	_ = json.Unmarshal(env["type"], &typ)
	if typ != "session" {
		return Frame{}, errors.New("invalid session response")
	}
	err := objectField(env, "message", func(message wireObject) error {
		var operation string
		_ = json.Unmarshal(message["type"], &operation)
		switch operation {
		case "workspace.create.response", "workspace.create.update", "workspace_update":
		default:
			return errors.New("unsupported creation response")
		}
		return objectField(message, "payload", func(payload wireObject) error {
			var agent func(wireObject) error
			agent = func(a wireObject) error { return virtualField(a, "cwd", environment) }
			workspace := func(w wireObject) error {
				setString(w, "projectId", project.ID)
				setString(w, "projectRootPath", project.Root)
				if err := virtualField(w, "workspaceDirectory", environment); err != nil {
					return err
				}
				return objectField(w, "project", func(place wireObject) error {
					return objectField(place, "checkout", func(checkout wireObject) error {
						for _, field := range []string{"cwd", "worktreeRoot"} {
							if err := virtualField(checkout, field, environment); err != nil {
								return err
							}
						}
						if raw, ok := checkout["mainRepoRoot"]; ok && string(raw) != "null" {
							setString(checkout, "mainRepoRoot", project.Root)
						}
						return nil
					})
				})
			}
			if err := objectField(payload, "workspace", workspace); err != nil {
				return err
			}
			if err := objectField(payload, "agent", agent); err != nil {
				return err
			}
			return objectField(payload, "creation", func(creation wireObject) error {
				if err := objectField(creation, "workspace", workspace); err != nil {
					return err
				}
				return objectField(creation, "agent", agent)
			})
		})
	})
	if err != nil {
		return Frame{}, err
	}
	data, err := json.Marshal(env)
	return Frame{Data: data}, err
}
