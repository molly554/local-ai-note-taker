# Yogurt help

Yogurt records your microphone and call audio, transcribes the meeting, and writes a Summary alongside your own notes. Processing stays on your computer. No bot joins the call.

## Install

Download Yogurt from [GitHub Releases](https://github.com/FrigadeHQ/yogurt/releases/latest). Every computer needs at least 8 GB of memory.

- **Mac:** Apple Silicon, macOS 14.4 or later. Open the DMG, drag Yogurt into Applications, then open it from Applications.
- **Windows:** Windows 10 version 2004 or later, x64. Run the `.exe` installer. The installer isn't signed yet: if Windows says it protected your PC, click More info, then Run anyway.
- **Linux:** x64, Ubuntu 22.04 or a compatible newer system, with PulseAudio or PipeWire. Make the `.AppImage` executable in its file properties, then open it. If it doesn't open, install FUSE 2 first: `sudo apt install libfuse2` on Ubuntu 22.04, `sudo apt install libfuse2t64` on 24.04 and newer. GNOME needs the AppIndicator extension to show the tray icon.

On first run, Yogurt downloads the models it needs. Windows and Linux also check transcription speed and stop setup if the computer cannot keep up. Recording works as soon as setup finishes. The notes model keeps downloading in the background, and notes and questions work offline once it's in. Calendar access and speaker names from calls are available on Mac only.

## Mac permissions

Microphone and call audio access let Yogurt hear both sides of a meeting. Allow them during setup, or open Settings in Yogurt to change them later. macOS lists call audio under Screen & System Audio Recording.

The other permissions are optional:

- **Calendar:** show upcoming meetings and use their titles and attendees.
- **Notifications:** offer to take notes when a call starts.
- **Accessibility:** read speaker names from supported call apps.

If a permission is off, use its button in Yogurt's Settings to open the right system pane. After changing it, return to Yogurt. Recording always waits for your click.

## Privacy

Audio, transcripts, notes, and questions are processed locally. Yogurt does not upload your meetings, and there is no telemetry.

Yogurt connects to the internet to download models from Hugging Face, to get Apple's optional on-device speech assets (on a Mac), and to check GitHub for updates. After setup it keeps downloading in the background: first a smaller notes model, then the best one your computer can run, which can be large (about 14 GB on a Mac with 64 GB of memory, about 63 GB with 96 GB or more). Updates download in the background and install when you quit. Links open in your browser. Copying and exporting does not upload your content.

If you [connect an AI app](#connect-an-ai-app), it may send what it reads to its own online model.

## Your data

Meetings, recordings, settings and downloaded models live here:

| Computer | Folder |
| --- | --- |
| Mac | `~/Library/Application Support/Yogurt` |
| Windows | `%APPDATA%\Yogurt` |
| Linux | `~/.config/Yogurt` (or `$XDG_CONFIG_HOME/Yogurt` if set) |

## Backup and restore

Finish any recording, then open **Settings → Backup** to export your meetings and audio to one ZIP file. Meetings in the Trash are not included.

Import a backup from the same section. It adds meetings that are missing and leaves existing meetings unchanged. Backups work across Mac, Windows and Linux.

## Connect an AI app

In **Settings → AI apps**, turn on access, copy the helper command, and add it as a local MCP server in your AI app. MCP lets that app read your meetings, notes and transcripts; it cannot change them. Yogurt does not edit the other app's configuration.

Access is off by default. A connected AI app may send what it reads to its own online model. Turn access off in Yogurt to stop further reads.

## Uninstall

Quit Yogurt first. On Mac, move Yogurt from Applications to the Trash. On Windows, uninstall it from Settings → Apps. On Linux, delete the AppImage.

Removing the app keeps your data. To remove that too, export a backup if you want one, then delete the Yogurt data folder listed above. This permanently removes your local meetings, recordings, settings and models.

## Report a problem

[Open a GitHub issue](https://github.com/FrigadeHQ/yogurt/issues) with your operating system, Yogurt version, what you did, what you expected and what happened. Leave private meeting content out of screenshots and reports.
