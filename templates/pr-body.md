### What does this PR do?

<!-- Two to four sentences: what was wrong, what this changes, and why this way
     rather than the obvious alternative.

     Not the reasoning trail. The analysis that got here is the plan, the plan
     is not published, and a reviewer who wanted it would ask. This section
     has run past four thousand characters of numbered argument for a change
     explainable in four sentences, and the four are what gets read.

     Budget: 600 characters. -->
{{what}}

**Where to look**
<!-- Point at the part that carries the logic, and say what the rest is.
     "40 lines of logic, the rest is mechanical renames" saves a reviewer more
     time than any amount of inline commentary.

     The value here is what a reviewer may SKIP. That is the opposite of
     listing the changes per file, which the diff already shows and which
     upstream has asked us not to restate.

     Budget: 300 characters. -->
{{whereToLook}}

**Not in this PR**
<!-- One line. On a sliced issue: what went into another slice, and which one —
     this is what stops a reviewer looking for the other half. On a single pull
     request there is no other half, and saying so takes one clause.

     Budget: 120 characters. -->
{{notInThisPr}}

### Screenshot / video of UI

<!-- Required when the PR changes UI. When it does not, say so and why rather
     than leaving the section empty: "n/a — no UI change" is an answer, an
     empty heading is a reviewer wondering whether it was forgotten.

     A description of a behavior change is not a screenshot. If it is visible,
     show it; if it is not, this is one line.

     The screenshots to show are the ones the validation took: preflight lists
     them, with their files. Nothing in the plugin can upload an image, so they
     go in as the links GitHub writes when the person drags each file into a
     comment box, and they go in before the self-review reads the body. Never
     "in a comment" or "later": a screenshot promised for later is one the
     reviewer does not have.

     Budget: 200 characters. -->
{{uiEvidence}}

### What issues does this PR fix or reference?

{{issueReferences}}
<!-- The closing line, and nothing else.

       Closes #12345      <!-- last slice of a stack; "Part of #12345" in the rest
       Fixes #12345       <!-- quickfix route

     No requirement table. R-IDs are how this plugin tracks its own work — they
     mean nothing to a reviewer, who has the issue and the diff — and a table
     mapping them to files is the "changes per file" upstream asked us to drop.
     The trace lives in the issue record and in `prs/<k>.md`, where the people
     who need it can read it.

     Budget: 200 characters. -->

### How to test this PR?

<!-- Each step is an action and an expected result. A reviewer should not have
     to guess what they are looking for. Required regardless of diff size: a
     small change does not make a reviewer better at guessing.

     THE ONE SECTION WITH NO BUDGET. Everything else here is being cut; this is
     not. Commands to paste, fixtures to create, what should come back, and the
     cleanup afterwards — a reviewer executes this section rather than reading
     it, which is why it is the last place to save room.

     This is a comment rather than a blockquote on purpose. A blockquote
     renders, and a reviewer would be reading instructions addressed to the
     author. -->
{{steps}}

**Notes for reviewers**
<!-- What CI could not judge, and the platform you checked it on: CI passing on
     something it never exercised reads as proof, which is worse than CI
     failing. And what the plan decided this body has to disclose — each line
     its `Body must disclose` names for this pull request, in a sentence of the
     reviewer's words: a behavior that changes without being asked for, a
     duplication kept on purpose, a decision the person made. A reviewer who is
     not told asks, and the person answers on the pull request what was
     settled before any code.

     Mandatory when preflight flagged build, packaging or platform-specific
     behavior, or listed lines the plan's `Body must disclose` names for this
     pull request; one line or omitted otherwise.

     What does NOT go here, and where it goes instead: the review history
     (the pull request conversation has it), residual risks and design
     alternatives (a review comment, or the issue), behavior nuance a reviewer
     cannot act on (nowhere). This section has passed four thousand characters
     that way.

     Budget: 400 characters. -->
{{notes}}

- [ ] Tests are covering the bug fix or the new feature

<!-- Filled in for you. The login comes from the `origin` remote of this clone,
     which `pdkit init` already read, so there is nothing to type and nothing to
     keep in step. When no login can be established the clause is left out
     rather than rendered empty: a footer may say less than usual, and must
     never name somebody who did not look.

     It is stated at all because a reviewer is entitled to know how a change
     reached them, and because the second half is the part that matters — a
     named person read this before it was opened.

     The harness is filled in too, after the plugin's name: preflight checks a
     pull request that is already open against this template again, and one
     opened under another harness names that one there. -->
<sub>Prepared with podman-desktop-kit{{harness}}{{reviewedBy}}</sub>
