# vhs tape for anchor demo gif.
# generates: .demo/demo.gif
# run: vhs .demo/demo.tape
#
# intended for use AFTER ~24h of anchor proxy dogfooding so the
# numbers shown reflect real cache hits, not synthetic data.

Output .demo/demo.gif

Set Shell zsh
Set FontSize 14
Set Width 1100
Set Height 580
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Framerate 24
Set PlaybackSpeed 1.0

Hide
Type "clear"
Enter
Show

Type "# anchor: local proxy that caches AI API calls"
Sleep 800ms
Enter

Sleep 300ms
Type "anchor stats week"
Enter
Sleep 4s

Type "# the green is money you didn't pay for"
Sleep 800ms
Enter

Sleep 300ms
Type "anchor stats week --share"
Enter
Sleep 4s

Type "# public dashboard. shareable. no telemetry."
Sleep 1500ms
Enter

Sleep 1s
