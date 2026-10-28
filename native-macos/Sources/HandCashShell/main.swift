import AppKit

let app = NSApplication.shared
let delegate = ShellAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
