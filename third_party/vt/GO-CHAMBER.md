# Local patch of charmbracelet/x/vt v0.1.0

Upstream source and tests are retained with their MIT license. Local changes:

- NewEmulator disables alternate-screen scrollback with SetScrollback(nil).
  SetScrollbackSize(0) does not disable it: nonpositive sizes retain defaults.
- csi_mode.go supports legacy mode 47 and matches xterm's shared cursor position
  for 47/1047, with saved cursor restoration for 1049. Browser contracts cover
  all three modes and continuation after returning to the primary buffer.

Upstream creates both screens with a 10,000-line history but exposes only the
primary history through Emulator, so the adapter cannot clear the hidden TUI
history. This patch keeps TUI redraws out of retained history and its memory.

`alternate_scrollback_test.go` reproduces the issue. Upstream tests run through
`make test-protocol-tools`. Rebase this patch when updating the dependency.
