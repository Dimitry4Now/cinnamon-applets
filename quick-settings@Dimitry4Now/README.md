# Quick Settings

A macOS-style control center for the Cinnamon panel.

**Tiles**

- **Wi-Fi**: the round icon turns Wi-Fi on or off. Clicking the rest of the tile opens the network list: connect, disconnect, and forget saved networks (click the trash icon twice). Cinnamon's own dialog asks for passwords.
- **Bluetooth**: the round icon turns Bluetooth on or off. Clicking the rest of the tile opens your paired devices and the devices nearby: pair, connect, disconnect, forget. Battery level is shown when a device reports it.
- **Do Not Disturb**, **Night Light**, **Dark Mode**, **Power Mode** (Balanced → Performance → Power Saver).
- Right-click any tile to open its settings.

**Also in the popup**: brightness and volume sliders (click the speaker to mute), and buttons for System Settings, Lock and Power Off.

## Requirements

- Cinnamon 6.x (tested on Linux Mint 22.2 with Cinnamon 6.4)
- NetworkManager, for Wi-Fi
- BlueZ, with blueman's agent for pairing prompts, for Bluetooth
- `power-profiles-daemon`, for Power Mode (the tile hides itself without it)

## Settings

The Dark Mode tile switches the applications (GTK), desktop (Cinnamon) and icon themes between a dark and a light set. The defaults are Mint-Y-Dark-Aqua and Mint-Y-Aqua. Leave a field empty to keep that theme unchanged.

To change them, right-click the applet → Configure.
