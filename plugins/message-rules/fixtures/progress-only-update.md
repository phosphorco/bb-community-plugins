---
version: 1
id: progress-only-update
sender_title: "#execution-steward"
destination_title: "#outcome-owner"
expect: reject
expected_rules: [avoid-status-pings]
---

# Message
Still working on it. I'll send another update soon.

# Sender context
The owner requested a completed result or a blocker.

# Destination context
The owner is waiting for a decision-ready report.

# Expected advice
Send a blocker, a decision request, or a completed result.
