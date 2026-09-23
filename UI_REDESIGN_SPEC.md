# UI Redesign Spec — Main Agent Chat

Reference mockup: `./image.png`

## Goal

Refactor the current mobile chat UI into a cleaner, more native, minimal agent interface based on `image.png`.

The app should feel modern on both iOS and Android, with a restrained pastel / pixel / CLI-inspired visual language. The main focus is the chat with the current main agent. Other agents exist, but the user primarily interacts through the main agent.

## Visual Direction

- Background: `#171717`
- Main accent: lavender based on `#D3D3FF`
- Lavender should be clearly visible, but slightly muted / softened
- Avoid neon-heavy effects, strong gradients, glassmorphism, and excessive glow
- Use subtle borders and contrast instead of decorative effects
- Chat elements should be more rectangular, with only slight corner rounding
- Typography should feel clean and native, with subtle CLI/mono influence only where useful
- Overall look should be calm, compact, functional, and slightly pixel-inspired

## Header

### Left: Agent Overview

Use the dot/grid icon as the navigation back to the overview of all agents.

Requirements:
- It should visually read as a navigation / overview control, not as a generic settings menu
- Keep it compact and native-looking
- Preserve the pixel/CLI character without making it look retro

### Right: Computer View

Provide a compact entry point for the computer/workspace view.

Requirements:
- Do not use a literal monitor icon
- Do not use a generic terminal window icon
- Prefer an abstract workspace / remote session / active environment concept
- Keep it visually simple and consistent with the rest of the UI

### Right: Account

Use a circular account badge with initials, similar to a finance app.

Example:
- `BT`

This opens the account area, from which all settings and subpages can be accessed.

Do not use a person-outline icon.

## Chat Area

The chat is the primary interface.

Requirements:
- Make the chat area visually distinct from the `#171717` page background
- Use a subtle darker/lighter surface, thin border, or restrained elevation
- Avoid making it look like a large heavy card
- Preserve a continuous vertical chat flow
- Avoid unnecessary separators or toolbars inside the chat

### Messages

- No agent avatar/icon beside assistant messages
- No prominent agent name labels
- Assistant messages: neutral dark surface with subtle border
- User messages: stronger lavender treatment
- Slightly squared corners
- Small, low-contrast timestamps
- Keep spacing generous and readable
- Avoid excessive metadata or action buttons

The mascot is enough to communicate the current agent identity.

## Mascot

Reserve a small area near the lower-left side of the chat / composer for the future pixel mascot.

For now:
- A simple pixel cat can remain as placeholder
- No separate agent avatar is needed
- The mascot should stay visually unobtrusive

Later this area should support:
- idle animation
- walking
- reactions
- typing/activity states

## Composer

Use a floating bottom composer similar to the reference in `image.png`.

Idle state should contain only:
- text input
- send button

Requirements:
- visually detached from the bottom edge
- clean native appearance on iOS and Android
- lavender border / accent may be used
- no permanent attach button
- no permanent agent selector
- no row of feature dots
- no multi-button tool cluster

Extra actions should appear only contextually when needed.

Example:
- attachments can appear inline near the composer/chat edge when content is present
- advanced actions can open through a single contextual control or overlay rather than permanent buttons

## Agent Model

The user primarily chats with one main agent.

The main agent may:
- research
- use tools
- delegate work to specialized agents
- coordinate other agents

The user does not need to switch agents inside the main chat composer.

Navigation to other agents happens through the agent overview.

## Settings / Secondary Features

Avoid permanent visible tabs such as:
- Memory
- Privacy
- Settings

Instead:
- Agent overview → top-left navigation
- Computer/workspace view → top-right action
- Account/settings/subpages → initials badge
- Context-specific tools → appear only when needed

## Cross-Platform

The UI must look intentional on both iOS and Android.

Avoid:
- strongly iOS-only interaction patterns
- old Android visual patterns
- platform-specific decorative elements that break consistency

Prefer:
- neutral spacing
- native-feeling touch targets
- simple system-like typography
- platform-safe status/navigation handling

## Remove from Current UI

Remove or replace:
- Memory / Privacy tabs
- agent icons beside messages
- person-outline account icon
- literal terminal/monitor icon for computer view
- bottom agent selector
- persistent attach button
- bottom feature-dot / multi-button cluster
- unnecessary labels and decorative text
- excessive rounding
- excessive effects

## Acceptance Criteria

The redesign is complete when:

- `image.png` is used as the visual reference
- chat is clearly the main focus
- the UI is noticeably cleaner and less busy
- lavender is more visible and characteristic
- chat area separates clearly from the background
- chat bubbles are more rectangular
- the top-left control clearly leads back to all agents
- account is represented by a circular initials badge
- computer view uses a cleaner, more abstract icon
- no agent avatars appear beside messages
- no permanent feature cluster is shown in the composer
- composer floats cleanly above the bottom edge
- the layout feels natural on both Android and iOS
- space remains available for the future mascot
