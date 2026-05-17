---
record_id: rules
record_type: program_page
schema_version: 1
title: rules & norms
order: 3
---

## comms

- **matrix is the canonical channel.** information about the program — scheduling, room assignments, room-level decisions, demo-day logistics, grant communications — is distributed there. *if you want information, you must join the matrix.* we do not maintain a parallel telegram group, slack, signal mirror, etc.
- **stewards run weekly office hours** (1hr per project, 30min per individual) via direct calendar slot. on-demand 1hr/day office hour is also open for ad-hoc unblocks.
- **escalation:** for a project-level blocker, your weekly office hour. for something urgent or program-level, ping andrew + tina in matrix.
- **the app (this thing)** mirrors the canonical state in `cohort-data/`. it doesn't replace matrix for live conversation.

## attendance

shape rotator is a 10-week in-person-anchored program. NYC at the convent is the default location; remote-friendly for paper-author advisors and bounded contributors.

**minimum participation** for full-cohort members:
- weekly 1:1 office hour (project + individual)
- weekly intention setting (monday) + retro (friday)
- show up to the cohort sessions in your week's slot (5–7pm mon/tue/thu)
- midterm demo day (thu jun 11) and graduation (fri jul 18) are non-optional

**no-meeting wednesday** is a real thing. nobody schedules cohort-wide programming on a wednesday. you can use the day for heads-down work, an ad-hoc unblock with a teammate, or a long lunch with another team. office hours run if a participant explicitly requests an exception; otherwise the day is yours.

**mornings are heads-down.** no required programming until lunch. don't disturb other people's projects before 4pm unless they specifically asked.

**weekends are off by default.** anything programmatic on a saturday or sunday is opt-in.

## money

grant funding flows in tiers per project. tier assignment was set at admission and is not re-negotiated based on weekly progress; how the funding is *paced* (early vs. milestone-gated) is something we'll discuss publicly in week 1.

- **expense policy:** routine cohort expenses (meals during sessions, demo-day venue, shared tooling) are pre-paid out of program funds. individual travel, gear, and team-specific costs are reimbursed by submitting receipts to alexis with a one-line description.
- **what's not in scope for reimbursement:** team payroll, project infrastructure costs above the grant tier, equity-affecting expenses.
- **grant amounts and tiers are not posted in this app.** financial detail lives in the private CRM (matrix DMs with andrew or tina). this repo is public; do not PR anything financial.

## conduct

- **disagreements** are surfaced in office hours first, not in matrix at midnight. if you and a teammate / another team are stuck, ask alexis or tina to mediate a 30-min sit-down. *this is not a passive-aggressive shape rotation; ask for help when you need it.*
- **feedback** is given with a rubric. peer evaluations are anonymized and structured around what the project tried to do — *not* a single yes/no on whether the project is "good." roasts and improv nights are entertainment, not feedback channels.
- **safe space.** the shape-rotator-journey ritual (weekly cohort-internal session, ~once a week) is for sharing what's actually going on — the key bottleneck, what's stuck, what you need help with. things shared in that room stay in that room.
- **everyone is a main character.** the social fabric is the program's competitive advantage. show up for it.

## what this app deliberately does NOT do

These are anti-patterns we ruled out by design. Don't propose adding them — read this section first.

- **No proficiency rankings** ("Rust: 4/5"). Skill chips are flat. Sources reading like stack-rank performance reviews kill collaboration. _(Source: MuchSkills critique of skill matrices.)_
- **No leaderboards or activity-count widgets.** At 15-team scale, anyone can see everyone — rankings turn the cohort competitive. _(Source: On Deck critique re. their leaderboard.)_
- **No bidirectional endorsements.** interviewing.io's data shows zero correlation between LinkedIn endorsement count and actual ability. Endorsements distribute uniformly because they're cheap. `pair_with` is deliberately one-sided self-assertion. _(Source: interviewing.io.)_
- **No "open to opportunities" badges.** Imports LinkedIn job-market semantics. We use verb-specific: "open to pair today", "🤝 pair on fuzzing".
- **No required weekly forms.** Buildspace's compliance issues show why. Use a single `now` field that you overwrite Monday — git history is the weekly log.
- **No avatar grid as default landing.** Lunchclub-style hot-or-not dynamic. We use shapes + chips, never face-tiles.
- **No surveillance edges.** Connection graph derives only from declared overlap (shared tags, paper_basis, dependencies). Never from inferred or counted private interactions.
- **No giant single-field bios as primary surface.** Multi-field structured profiles only. A 400-word bio is unsearchable.
- **No swipe / algorithmic match UI.** For 15 teams (~30-60 people), filter + browse + DM is enough. An algorithm just adds opacity.
- **No "fun facts" framing for the personal API.** Atlassian's My User Manual structure (work / communicate / feedback / values / achieve) — operational, not anecdotal.

## what this app deliberately does NOT do

These are anti-patterns we ruled out by design. Don't propose adding them — read this section first.

- **No proficiency rankings** ("Rust: 4/5"). Skill chips are flat. Sources reading like stack-rank performance reviews kill collaboration. _(Source: MuchSkills critique of skill matrices.)_
- **No leaderboards or activity-count widgets.** At 15-team scale, anyone can see everyone — rankings turn the cohort competitive. _(Source: On Deck critique re. their leaderboard.)_
- **No bidirectional endorsements.** interviewing.io's data shows zero correlation between LinkedIn endorsement count and actual ability. Endorsements distribute uniformly because they're cheap. `pair_with` is deliberately one-sided self-assertion. _(Source: interviewing.io.)_
- **No "open to opportunities" badges.** Imports LinkedIn job-market semantics. We use verb-specific: "open to pair today", "🤝 pair on fuzzing".
- **No required weekly forms.** Buildspace's compliance issues show why. Use a single `now` field that you overwrite Monday — git history is the weekly log.
- **No avatar grid as default landing.** Lunchclub-style hot-or-not dynamic. We use shapes + chips, never face-tiles.
- **No surveillance edges.** Connection graph derives only from declared overlap (shared tags, paper_basis, dependencies). Never from inferred or counted private interactions.
- **No giant single-field bios as primary surface.** Multi-field structured profiles only. A 400-word bio is unsearchable.
- **No swipe / algorithmic match UI.** For 15 teams (~30-60 people), filter + browse + DM is enough. An algorithm just adds opacity.
- **No "fun facts" framing for the personal API.** Atlassian's My User Manual structure (work / communicate / feedback / values / achieve) — operational, not anecdotal.

If you're adding a new surface or schema field, check this list first. If your idea contradicts an entry here, propose explicitly why — don't introduce silently.
