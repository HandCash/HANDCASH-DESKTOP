# Telegram-Parity Chat Feature — Implementation Plan

## Executive Summary

The HandCash Desktop codebase already has **~90% of the call infrastructure implemented** in `src/wallet/calls/`:
- Full WebRTC call engine with 1:1 and group calls (mesh topology)
- Screen sharing via Electron desktop capture
- Call recording with E2E-encrypted parts stored locally
- Media E2E encryption via identity-derived keys
- Signaling over BRC-169 direct sessions (messagebox)

**What's missing: UI integration** — no call dock, incoming call screen, call buttons in chat, group call management, recording playback, or settings.

This plan scopes the remaining 10% to reach Telegram-level UX.

---

## Current Architecture

### Messaging (Complete)
| Component | Location | Status |
|-----------|----------|--------|
| Local message store | `src/wallet/messageStore.ts` | ✅ Complete |
| BRC-169 messagebox transport | `src/wallet/messageTransport.ts` | ✅ Complete |
| Friends/contacts | `src/wallet/friends.ts` | ✅ Complete |
| Chat UI (sidebar, thread, composer) | `src/components/messages/` | ✅ Complete |
| Payment/tip/file commands | `src/features/messages/` | ✅ Complete |

### Calls (Backend Complete, UI Missing)
| Component | Location | Status |
|-----------|----------|--------|
| Call state machine (XState) | `src/machines/callMachine.ts` | ✅ Complete |
| Call view machine (stage/pip/popped) | `src/machines/callViewMachine.ts` | ✅ Complete |
| Call engine (WebRTC, mesh, E2EE) | `src/wallet/calls/callEngine.ts` | ✅ Complete |
| Signaling (direct sessions) | `src/wallet/calls/callService.ts` | ✅ Complete |
| Screen capture (Electron bridge) | `src/wallet/calls/screenCapture.ts` | ✅ Complete |
| Call recorder (MediaRecorder + mixer) | `src/wallet/calls/callRecorder.ts` | ✅ Complete |
| Recording mixer (grid layout) | `src/wallet/calls/recordingMixer.ts` | ✅ Complete |
| Recording crypto (E2E sealed parts) | `src/wallet/calls/recordingCrypto.ts` | ✅ Complete |
| Recording store (desktop shell) | `src/wallet/calls/recordingStore.ts` | ✅ Complete |
| Call history (Activity) | `src/wallet/calls/callHistory.ts` | ✅ Complete |
| Media keys / frame protector | `src/wallet/calls/mediaKeys.ts` | ✅ Complete |
| Device selection (mic/camera) | `src/wallet/calls/mediaDevices.ts` | ✅ Complete |

### Call UI (Missing)
| Component | Status |
|-----------|--------|
| Incoming call screen | ❌ Missing |
| Call dock (active call bar) | ❌ Missing |
| Call button in chat header | ❌ Missing |
| Group call participant grid | ❌ Missing |
| Screen share button | ❌ Missing |
| Record button | ❌ Missing |
| Recording playback | ❌ Missing |
| Call settings panel | ❌ Missing |
| Call history in Activity | ❌ Missing |

---

## Implementation Phases

### Phase 1: Core Call UI (Week 1-2)
**Goal**: Make and receive 1:1 voice/video calls with screen sharing.

#### 1.1 Incoming Call Screen (`src/components/calls/IncomingCallScreen.tsx`)
- Full-screen modal when call arrives
- Shows caller avatar, name, video/audio indicator
- Accept (video/audio), Decline buttons
- Rings via existing `ringtone.ts`
- Integrates with `callEngine().accept({ video })` and `callEngine().decline()`

#### 1.2 Call Dock (`src/components/calls/CallDock.tsx`)
- Persistent bar at bottom of app during active call (uses `callViewMachine` stage/pip/popped)
- Shows: call duration, peer name/avatar, mute, camera toggle, screen share, hang up
- Draggable to corners (pip mode), expands on click
- System PiP support via `callViewMachine` popped state

#### 1.3 Call Button in Chat Header
- Add call/video icons to `ChatThreadHeader.tsx`
- `callEngine().call(peerId, { video: false/true })`
- Only enabled for friends (not blocked)

#### 1.4 Screen Share Button in Call Dock
- Uses `callEngine().canShareScreen()` and `callEngine().shareScreen(sourceId)`
- Source picker via Electron bridge (`screenCapture.listScreenSources()`)
- Shows "You're sharing" indicator

#### 1.5 Integration Points
- `useCall()` hook already exists in `src/features/calls/useCall.ts`
- Subscribe to `callEngine()` in App root or MessagesPanel
- Show `IncomingCallScreen` when `callEngine().getSnapshot().matches('incoming')`
- Show `CallDock` when `callEngine().busy()`

### Phase 2: Group Calls (Week 2-3)
**Goal**: Add multiple participants to a call.

#### 2.1 Group Call UI (`src/components/calls/GroupCallGrid.tsx`)
- Grid layout for 3+ participants (uses `callEngine().participants()`)
- Shows each participant's video/avatar, name, mute status, speaking indicator
- Host controls: invite more, remove participant

#### 2.2 Invite to Call (`src/components/calls/InviteToCallPanel.tsx`)
- Host-only: search friends, add to ongoing call
- Uses `callEngine().canInvite()` and `callEngine().invite(peerId)`
- Respects `CALL_MAX_PARTICIPANTS` limit

#### 2.3 Call Roster Display
- Show all members in call dock/header
- "Bob, Carol and 2 others" format via `callMembersLabel()`

### Phase 3: Call Recording (Week 3)
**Goal**: Record and play back calls.

#### 3.1 Record Button in Call Dock
- Toggle recording: `callEngine().startRecording()` / `stopRecording()`
- Shows recording indicator (red dot, duration)
- Requires `recordingStoreAvailable()` (desktop only)

#### 3.2 Recording Playback (`src/components/calls/RecordingPlayer.tsx`)
- List recordings in Activity or dedicated Recordings panel
- Play via `openCallRecording(id)` → returns Blob URL
- Shows participants, duration, date
- Seek, volume, download

#### 3.3 Recording Notice
- Uses existing `recordingNotice(self, others)` in call dock
- "You're recording this call" / "Bob is recording this call"

### Phase 4: Call History & Activity Integration (Week 3-4)
**Goal**: Calls appear in Activity like messages.

#### 4.1 Activity Rows for Calls
- Use `callOutcomeText(record)` from `callHistory.ts`
- Icons: video/camera, incoming/outgoing, missed/finished
- Click to open recording (if exists) or call back

#### 4.2 Call History Panel
- Filter: all, missed, recorded
- Search by contact name
- Export call log

### Phase 5: Settings & Polish (Week 4)
**Goal**: User preferences and edge cases.

#### 5.1 Call Settings Panel (`src/components/settings/CallsPanel.tsx`)
- Default video on/off
- Microphone/camera selection (persisted via `callSettings.ts`)
- Recording enabled/disabled
- Ringtone selection
- Echo cancellation, noise suppression toggles

#### 5.2 Device Management
- Uses existing `useCallDevices()` hook
- Test mic/camera before call
- Remember last used devices

#### 5.3 Edge Cases
- Call fails: show `failure` reason from call machine
- Network issues: reconnecting indicator
- E2EE status: show safety code verification
- Account switch/lock: `endCalls()` already handled

---

## Detailed Component Specifications

### IncomingCallScreen.tsx
```tsx
// Props: { onAccept: (video: boolean) => void; onDecline: () => void; caller: Friend; video: boolean }
// Full screen, high z-index, prevents backdrop interaction
// Rings via ringtone.ts (already integrated in callEngine)
// Shows: avatar, name, "Video call" / "Voice call", accept/decline buttons
// Keyboard: Space = accept audio, Shift+Space = accept video, Escape = decline
```

### CallDock.tsx
```tsx
// Uses callViewMachine (stage/pip/popped) for positioning
// Stage: full-width bar at bottom with all controls
// Pip: small draggable tile in corner (nearestCorner)
// Popped: system PiP window (browser Picture-in-Picture API)
// Controls: mute, camera, screen share, record, hang up, participants (group)
// Shows: peer label, call duration, connection quality
```

### GroupCallGrid.tsx
```tsx
// Grid of participant tiles (from callEngine().participants())
// Each tile: video/avatar, name, mute icon, speaking indicator (audio level)
// Host badge, remove button (host only)
// Responsive: 1 col < 480px, 2 col < 768px, 3 col < 1024px, 4+ col larger
```

### RecordingPlayer.tsx
```tsx
// List: date, participants, duration, recording icon
// Player: standard <video>/<audio> controls
// Download: saves Blob as .webm
// Delete: deleteCallRecording(id)
```

---

## Data Flow

```
User clicks "Call" in chat
    → callEngine().call(peerId, { video })
    → callService.connect() → direct session → messagebox knock
    → callMachine: DIAL → outgoing.reaching → outgoing.ringing
    → Far side: INCOMING → IncomingCallScreen shown
    → Accept: ACCEPT → connecting → MEDIA_CONNECTED → active
    → Media: getUserMedia → RTCPeerConnection (per leg) → MediaPeer
    → E2EE: mediaSecret() → callKeys() → FrameProtector seals frames
    → Screen share: captureScreen(sourceId) → swapTrack('video', screenTrack)
    → Record: startCallRecording() → mixer.sync() → MediaRecorder → sealed parts → store
    → Hang up: HANG_UP → ended → recordCall() → Activity row
```

---

## Acceptance Criteria (Telegram Parity)

| Feature | Telegram Behavior | Implementation |
|---------|-------------------|----------------|
| 1:1 voice call | Tap call icon → rings → connect | Phase 1.1, 1.3 |
| 1:1 video call | Tap video icon → camera on → connect | Phase 1.1, 1.3 |
| Group call | Add participants during call | Phase 2.1, 2.2 |
| Screen share | Share screen/window/tab | Phase 1.4 |
| Call recording | Record button → saves locally | Phase 3.1, 3.2 |
| Recording playback | List recordings, play, download | Phase 3.2 |
| Call history | In chat list / activity | Phase 4.1 |
| PiP mode | Minimize to corner, system PiP | Phase 1.2 (callViewMachine) |
| Mute/camera toggle | During call, instant | Phase 1.2 |
| Safety code | Verify E2EE | callEngine.safetyCode() |
| Devices | Select mic/camera, remember | Phase 5.2 |

---

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| WebRTC not available in some Electron versions | `callEngine` already guards with `rtc()` check; show "Calls unavailable" |
| Screen capture permission (macOS) | `screenCapture.ts` already handles; guide to System Settings |
| Group call bandwidth (mesh) | `GROUP_VIDEO_BITRATE = 600kbps` cap per sender; max 8 participants |
| Recording storage | Parts sealed & stored in desktop shell; user manages disk space |
| Mobile parity | This plan is Desktop-only; Mobile needs separate WebRTC impl |

---

## File Tree (New Files)

```
src/components/calls/
├── IncomingCallScreen.tsx
├── CallDock.tsx
├── GroupCallGrid.tsx
├── InviteToCallPanel.tsx
├── RecordingPlayer.tsx
├── CallControls.tsx          # Shared buttons (mute, camera, share, record, hangup)
├── ParticipantTile.tsx       # Single tile for group grid
└── index.ts

src/components/settings/
├── CallsPanel.tsx            # Call settings UI
└── index.ts                  # Export CallsPanel

src/features/calls/
├── useIncomingCall.ts        # Hook for incoming call state
├── useCallDock.ts            # Hook for call dock state
├── useGroupCall.ts           # Hook for group call management
├── useCallRecording.ts       # Hook for recording controls
└── index.ts                  # Export new hooks

src/machines/
└── (callMachine.ts, callViewMachine.ts already exist)

tests/
├── calls/
│   ├── IncomingCallScreen.test.tsx
│   ├── CallDock.test.tsx
│   ├── GroupCallGrid.test.tsx
│   ├── RecordingPlayer.test.tsx
│   └── callIntegration.test.ts
```

---

## Integration Points (Existing Code)

| Existing | Used By New UI |
|----------|----------------|
| `callEngine()` | All call components |
| `useCall()` | CallDock, GroupCallGrid |
| `callEngine().call()` | ChatThreadHeader call button |
| `callEngine().accept()` | IncomingCallScreen |
| `callEngine().shareScreen()` | CallDock screen share button |
| `startCallRecording()` | CallDock record button |
| `openCallRecording()` | RecordingPlayer |
| `listCallRecords()` | Activity, Call History panel |
| `useCallDevices()` | CallsPanel, pre-call test |
| `callViewMachine` | CallDock positioning |

---

## Testing Strategy

1. **Unit**: XState machines (callMachine, callViewMachine) — already tested
2. **Integration**: callEngine with fake RTCPeerConnection (mediaPeer.test.ts exists)
3. **E2E**: Playwright tests for:
   - Incoming call appears, accept/decline works
   - Outgoing call connects, media flows
   - Screen share starts/stops
   - Recording creates playable file
   - Group call adds/removes participants
   - PiP mode transitions

---

## Effort Estimate

| Phase | Components | Est. Days |
|-------|------------|-----------|
| 1: Core Call UI | IncomingCallScreen, CallDock, Chat integration, Screen share | 8-10 |
| 2: Group Calls | GroupCallGrid, InviteToCallPanel, Roster | 5-7 |
| 3: Recording | Record button, RecordingPlayer, Notice | 4-5 |
| 4: History/Activity | Activity rows, History panel | 3-4 |
| 5: Settings/Polish | CallsPanel, Device mgmt, Edge cases | 4-5 |
| **Total** | | **24-31 days** |

---

## Next Steps

1. **Review this plan** — confirm scope and priorities
2. **Start Phase 1** — create `IncomingCallScreen.tsx` and `CallDock.tsx`
3. **Wire into MessagesPanel** — add call buttons, subscribe to call engine
4. **Add to nav** — "Calls" in Activity or separate tab
5. **Iterate with user testing** — real WebRTC conditions vary

---

*Plan created from codebase analysis of existing `src/wallet/calls/` infrastructure and `src/components/messages/` UI.*