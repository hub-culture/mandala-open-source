# Council custody (draft spec)

*Status: draft, 24 November 2026. The open specification. The service that runs it lives in HubID and is not part of this repo.*

## Why

Today a Mandala agent's custodian is one person: they set its limits, approve held payments and answer for it. Agents that act for an organisation (the agent of a Hub, a community's chief agent, a treasury) need a **council**: a set of people who share custody, so that no one person can move value or change the agent's mandate alone.

## Who the council is

A council is one of the following:

| Kind | Members | Notes |
|---|---|---|
| `hub_admins` | The admins of a HubID Hub (group) and its pavilion | The default for an agent of a Hub. HubID holds the list, and changes apply at once. |
| `listed` | An explicit list of HubIDs | For bodies with no Hub, such as an arm's-length community or a trust. |

A council never includes the agent itself, or any other agent. Only people sit on a council.

## Rules

Each council has these settings:

- **`threshold`:** how many members must approve a held action. The default is `min(2, size)`.
- **`freeze`:** how many members can freeze a pending action or the agent itself. The default is 2. It is never more than the threshold.
- **The agent's spend limits:** per transaction, per day and an approval line, as single-custodian limits are today. At or above the line, an action is held for council approval.

Behaviour:
- **Approvals.** A held action executes when `threshold` distinct members approve it, before it expires. One rejection does not end it. It ends when a threshold can no longer be reached, or it expires.
- **Freeze.** `freeze` distinct members can freeze a pending action, or the agent's spending. Unfreezing needs `threshold` approvals.
- **Changes to the council or its rules** need `threshold` approvals. For a `hub_admins` council, membership follows the Hub's admin list, and only the rules need approval.
- **Changes to the mandate** (scopes, limits, channels) come from the body's own governance. For a Hub, that is a passed Propel statement of category `mandate`. The council can tighten a mandate at once; it cannot widen one past what was voted.
- **Audit.** Every approval, rejection, freeze, unfreeze and rule change is written to the agent's audit chain, with the acting HubID.

## API shape (proposed)

These extend the existing custodian routes in HubID.

| Method and path | Who | What |
|---|---|---|
| `GET /mandala/custodian/agents/{id}/council` | council member | Kind, members, threshold, freeze, and pending items |
| `PUT /mandala/custodian/agents/{id}/council` | council (needs threshold) | Set kind, threshold and freeze |
| `POST /mandala/custodian/approvals/{id}/approve` | council member | Records one approval; executes when the threshold is met |
| `POST /mandala/custodian/approvals/{id}/freeze` | council member | Records one freeze vote |
| `POST /mandala/custodian/agents/{id}/mandate` | the Hub's governance (Propel, app key) | Applies a passed mandate, by statement id and text hash |

An agent reading its own state (`GET /mandala/v1/me`) sees `custody: "council"` and its owner, the Hub, but never the council's members.

## Compatibility

- Single-custodian agents are unchanged. They are a council of one, with threshold 1.
- A Hub's agent can start with its founding admin as sole custodian and move to `hub_admins` once council custody ships. The move needs that custodian's approval.
