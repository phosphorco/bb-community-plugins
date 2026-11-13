---
version: 1
id: q-a-s-b
project_id: project-test
project_title: Test project
sender_id: sender-b
destination_id: receiver
sender_title: Sender B
destination_title: Receiver
expect: allow
expected_rules: []
expected_route: queue-batched
---
# Message
Choose the next step.

# Native placement
```json
{
  "input": {
    "version": 1,
    "simulation": true,
    "now": "2026-11-12T00:00:00Z",
    "candidate": {
      "version": 1,
      "operation": {
        "namespace": "fixture",
        "operationId": "q-a-s-b"
      },
      "requestFingerprint": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "original": {
        "originalId": "B",
        "revision": 1
      },
      "threadId": "receiver",
      "projectId": "project-test",
      "rawInput": {
        "text": "Choose the next step."
      },
      "policyContext": {
        "messageText": "Choose the next step.",
        "projectTitle": "Test project",
        "senderTitle": "Sender B",
        "destinationTitle": "Receiver"
      },
      "requestedIntent": {
        "mode": "proceed",
        "membership": "preserve",
        "schedule": {
          "kind": "ordinary"
        },
        "execution": {
          "provider": "test-provider",
          "model": "test-model",
          "reasoning": "medium",
          "serviceTier": "default",
          "permissionMode": "default",
          "canAsk": false,
          "configuration": {}
        }
      },
      "source": {
        "senderThreadId": "sender-b",
        "initiator": "agent",
        "author": {
          "sender": "sender-b"
        },
        "editor": null,
        "origin": null,
        "externalOperation": null,
        "visibleHumanActivity": false
      },
      "kind": "message",
      "override": "none",
      "expectedPlacementWitness": null
    },
    "queue": [
      {
        "groupId": "ordinary-a",
        "originals": [
          {
            "version": 1,
            "original": {
              "originalId": "A",
              "revision": 1
            },
            "operation": {
              "namespace": "fixture",
              "operationId": "A"
            },
            "requestFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "threadId": "receiver",
            "rawInput": {
              "text": "A"
            },
            "source": {
              "senderThreadId": "sender-a",
              "initiator": "agent",
              "author": {
                "sender": "sender-a"
              },
              "editor": null,
              "origin": null,
              "externalOperation": null,
              "visibleHumanActivity": false
            },
            "requestedIntent": {
              "mode": "queue",
              "membership": "preserve",
              "schedule": {
                "kind": "ordinary"
              },
              "execution": {
                "provider": "test-provider",
                "model": "test-model",
                "reasoning": "medium",
                "serviceTier": "default",
                "permissionMode": "default",
                "canAsk": false,
                "configuration": {}
              }
            },
            "effectiveIntent": {
              "mode": "queue",
              "membership": "preserve",
              "schedule": {
                "kind": "ordinary"
              },
              "execution": {
                "provider": "test-provider",
                "model": "test-model",
                "reasoning": "medium",
                "serviceTier": "default",
                "permissionMode": "default",
                "canAsk": false,
                "configuration": {}
              },
              "changes": []
            },
            "acceptedAt": "2026-11-12T00:00:00Z",
            "acceptanceSequence": 1,
            "admission": {
              "kind": "evaluated",
              "publications": [],
              "assessments": []
            }
          }
        ],
        "joinState": "open",
        "claimed": false,
        "blocked": false,
        "orderKey": "1",
        "witness": "target-a"
      },
      {
        "groupId": "scheduled-s",
        "originals": [
          {
            "version": 1,
            "original": {
              "originalId": "S",
              "revision": 1
            },
            "operation": {
              "namespace": "fixture",
              "operationId": "S"
            },
            "requestFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "threadId": "receiver",
            "rawInput": {
              "text": "S"
            },
            "source": {
              "senderThreadId": "sender-s",
              "initiator": "agent",
              "author": {
                "sender": "sender-s"
              },
              "editor": null,
              "origin": null,
              "externalOperation": null,
              "visibleHumanActivity": false
            },
            "requestedIntent": {
              "mode": "queue",
              "membership": "preserve",
              "schedule": {
                "kind": "scheduled",
                "notBefore": "2026-12-01T00:00:00Z"
              },
              "execution": {
                "provider": "test-provider",
                "model": "test-model",
                "reasoning": "medium",
                "serviceTier": "default",
                "permissionMode": "default",
                "canAsk": false,
                "configuration": {}
              }
            },
            "effectiveIntent": {
              "mode": "queue",
              "membership": "preserve",
              "schedule": {
                "kind": "scheduled",
                "notBefore": "2026-12-01T00:00:00Z"
              },
              "execution": {
                "provider": "test-provider",
                "model": "test-model",
                "reasoning": "medium",
                "serviceTier": "default",
                "permissionMode": "default",
                "canAsk": false,
                "configuration": {}
              },
              "changes": []
            },
            "acceptedAt": "2026-11-12T00:00:00Z",
            "acceptanceSequence": 2,
            "admission": {
              "kind": "evaluated",
              "publications": [],
              "assessments": []
            }
          }
        ],
        "joinState": "open",
        "claimed": false,
        "blocked": false,
        "orderKey": "2",
        "witness": "target-s"
      }
    ]
  },
  "expect": {
    "status": "join",
    "targetGroupId": "ordinary-a",
    "orderedOriginalIds": [
      "A",
      "B"
    ],
    "reasonCodes": []
  }
}
```
