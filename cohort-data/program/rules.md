---
record_id: rules
record_type: program_page
schema_version: 1
title: rules & norms
order: 3
---

## comms

_(placeholder — matrix server is the canonical channel. how to find people, how to escalate, how steward office hours work.)_

## attendance

_(placeholder — the bare-minimum participation expectation. what counts as showing up. what "no-meeting Wednesday" actually means.)_

## money

_(placeholder — expense policy, how grants/milestones flow, what's pre-paid vs reimbursed.)_

## conduct

_(placeholder — the explicit norms. how disagreements are handled. how feedback is given.)_

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
