---
name: cross-agent-protocol
description: >
  Structured protocol for cross-agent communication via issue comments.
  Use when you need input, approval, or expertise from another agent.
  Defines @request and @respond conventions that trigger automatic agent waking.
---

# Cross-Agent Communication Protocol

When you need input from another agent — a review, approval, data, or expertise — use this structured protocol in issue comments. The system will automatically wake the target agent.

## Requesting Help from Another Agent

Post a comment on the issue using the `@request` format:

```
@request(agent=<agent-name>, type=<request-type>)
<your request details here>
```

**Request types:**

| Type | When to use |
|------|-------------|
| `review` | Need another agent to review your work or output |
| `approval` | Need sign-off before proceeding (budget, legal, compliance) |
| `info` | Need data or context the other agent has |
| `action` | Need the other agent to do something specific |

**Examples:**

```
@request(agent=oro, type=approval)
Campaign proposal: €15K for Q2 social media ads targeting B2B SaaS.
Please confirm this is within budget before I proceed with creative.
```

```
@request(agent=nora, type=review)
Employment contract draft for new contractor. Need compliance check
for Canary Islands labor law requirements before sending.
```

```
@request(agent=tony, type=info)
What is the current API rate limit for the product catalog endpoint?
Need this to design the data sync workflow.
```

## Responding to Requests

When you see a comment containing `@request(agent=<your-name>, ...)`, respond with:

```
@respond(status=<status>)
<your response details>
```

**Response statuses:**

| Status | Meaning |
|--------|---------|
| `approved` | Request is approved, requester can proceed |
| `rejected` | Request is denied, include reason |
| `answered` | Information provided |
| `done` | Requested action completed |
| `blocked` | Cannot fulfill — explain what's needed |

**Examples:**

```
@respond(status=approved)
Approved. Q2 discretionary budget has €22K remaining. This fits.
```

```
@respond(status=rejected)
Cannot approve — this would exceed the Q2 marketing budget by €3K.
Consider reducing to €12K or splitting across Q2/Q3.
```

## Rules

1. **One request per comment.** Don't combine multiple requests — each gets its own comment.
2. **Be specific.** Include enough context that the target agent can respond without asking follow-up questions.
3. **Check before requesting.** Use `search_memories` or read issue history before asking another agent for information you might already have.
4. **Don't request from yourself.** If the task is within your own expertise, just do it.
5. **Escalation path:** If your request goes unanswered after your next run, escalate to your manager (C-suite agent) by creating a comment noting the blocked dependency.
6. **Cross-department requests** should go to the department head (CEO for company-wide, CTO for technical, CFO for financial, CMO for marketing) who will route to the right specialist.
