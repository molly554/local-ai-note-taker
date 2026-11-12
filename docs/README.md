# Lynote NoteTaker help

Lynote NoteTaker records your microphone and call audio, transcribes the meeting, and writes a Summary alongside your own notes. Processing stays on your computer unless you turn on Cloud AI. No bot joins the call.

## Install

Download Lynote NoteTaker from [GitHub Releases](https://github.com/molly554/local-ai-note-taker/releases/latest). Every computer needs at least 8 GB of memory.

- **Windows:** Windows 10 version 2004 or later, x64. Run the `.exe` installer. The installer isn't signed: if Windows says it protected your PC, click More info, then Run anyway.
- **Linux:** x64, Ubuntu 22.04 or a compatible newer system, with PulseAudio or PipeWire. Make the `.AppImage` executable in its file properties, then open it. If it doesn't open, install FUSE 2 first: `sudo apt install libfuse2` on Ubuntu 22.04, `sudo apt install libfuse2t64` on 24.04 and newer. GNOME needs the AppIndicator extension to show the tray icon.
- **Mac:** there is no download. On Apple Silicon with macOS 14.4 or later it can be [built from source](building.md).

On first run, Lynote NoteTaker downloads the models it needs. Windows and Linux also check transcription speed and stop setup if the computer cannot keep up. Recording works as soon as setup finishes. The notes model keeps downloading in the background, and notes and questions work offline once it's in. Calendar access and speaker names from calls are available on Mac only.

## Languages

- **The language of your meetings.** Pick it in the bar under a note while you record, or in Settings (before your first meeting it is also on the home screen): English, Chinese, Japanese, Korean, Spanish, French, German, Portuguese or Russian, or Multi-language to listen for whichever is spoken. It starts as your computer's language when that is one of these.
- **The language of your notes.** Settings → Notes language. "Same as the meeting" writes the Summary in the language that was spoken; any other choice writes every Summary in that language.
- **The app itself** comes in English and 31 other languages and follows your computer's language (Settings → Language to change it).

## Mac permissions

Microphone and call audio access let Lynote NoteTaker hear both sides of a meeting. Allow them during setup, or open Settings to change them later. macOS lists call audio under Screen & System Audio Recording.

The other permissions are optional:

- **Calendar:** show upcoming meetings and use their titles and attendees.
- **Notifications:** offer to take notes when a call starts.
- **Accessibility:** read speaker names from supported call apps.

If a permission is off, use its button in Settings to open the right system pane. After changing it, return to the app. Recording always waits for your click.

## Privacy

Audio, transcripts, notes, and questions are processed on your computer. Lynote NoteTaker does not upload your meetings, and there is no telemetry.

It connects to the internet to download models from Hugging Face, to get Apple's optional on-device speech assets (on a Mac), and to check GitHub for updates. After setup it keeps downloading in the background: first a smaller notes model, then the best one your computer can run, which can be large (about 14 GB on a Mac with 64 GB of memory, about 63 GB with 96 GB or more). Updates download in the background and install when you quit. Links open in your browser. Copying and exporting does not upload your content.

Two things send your content somewhere else, and both are off until you turn them on:

- **[Cloud AI](#cloud-ai)** sends your transcripts (with each meeting's title and the names of the people invited), your own notes and your questions to the service you chose, which writes the notes and the answers.
- **[A connected AI app](#connect-an-ai-app)** may send what it reads to its own online model.

Recordings never leave your computer in either case.

## Cloud AI

A notes model needs a strong computer. On one that is too slow, **Settings → Cloud AI** lets a model online do the notes model's work instead: Summaries, titles, folder suggestions and answers to your questions. It is off by default.

Turn it on, then enter the service's address, the model's name and your API key. Any service that speaks the OpenAI chat format works (the address usually ends in `/v1`). The key is encrypted with your system's own key storage (the Mac's Keychain, Windows' data protection, the Linux keyring) before it is saved, and it is only sent to the address you entered. Where the system has no such storage, the key is not saved.

While it is on, your transcripts (with the meeting's title and the people invited), your own notes and your questions are sent to that service. Transcription still happens on your computer, and recordings are never sent. The service's own terms decide what it keeps. Turn the switch off to go back to the model on your computer.

Setup still downloads the models for your computer when Cloud AI is on, and it still stops on a computer that cannot transcribe a meeting as fast as people talk.

## Your data

Meetings, recordings, settings and downloaded models live here:

| Computer | Folder |
| --- | --- |
| Mac | `~/Library/Application Support/Lynote NoteTaker` |
| Windows | `%APPDATA%\Lynote NoteTaker` |
| Linux | `~/.config/Lynote NoteTaker` (or `$XDG_CONFIG_HOME/Lynote NoteTaker` if set) |

## Backup and restore

Finish any recording, then open **Settings → Backup** to export your meetings and audio to one ZIP file. Meetings in the Trash are not included.

Import a backup from the same section. It adds meetings that are missing and leaves existing meetings unchanged. Backups work across Mac, Windows and Linux.

## Connect an AI app

In **Settings → AI apps**, turn on access, copy the helper command, and add it as a local MCP server in your AI app. MCP lets that app read your meetings, notes and transcripts; it cannot change them. Lynote NoteTaker does not edit the other app's configuration.

Access is off by default. A connected AI app may send what it reads to its own online model. Turn access off to stop further reads.

## Uninstall

Quit Lynote NoteTaker first. On Mac, move it from Applications to the Trash. On Windows, uninstall it from Settings → Apps. On Linux, delete the AppImage.

Removing the app keeps your data. To remove that too, export a backup if you want one, then delete the data folder listed above. This permanently removes your local meetings, recordings, settings and models.

## Report a problem

[Open a GitHub issue](https://github.com/molly554/local-ai-note-taker/issues) with your operating system, the app's version, what you did, what you expected and what happened. Leave private meeting content out of screenshots and reports.
