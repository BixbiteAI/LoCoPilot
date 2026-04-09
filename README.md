# LoCoPilot

**The offline AI coding assistant.** Autocomplete, chat, and agent mode—all running locally. No internet, no API keys, no data leaving your machine.

LoCoPilot by **Bixbite AI** brings AI pair programming to your desktop. Use local language models for private, offline development, or add cloud models when you want. Built on VS Code—familiar editor, full control.

<p align="center">
  <a href="https://youtu.be/_HHLXmmzt3Q">
    <img src="https://img.youtube.com/vi/_HHLXmmzt3Q/maxresdefault.jpg" alt="Watch LoCoPilot demo" width="800"/>
  </a>
  <br/>
  <a href="https://youtu.be/2yGY0glkj4E">▶ Watch demo on YouTube</a>
</p>

---

## Why LoCoPilot?


|                   | LoCoPilot                                                        |
| ----------------- | ---------------------------------------------------------------- |
| **Privacy**       | Code stays on your machine                                       |
| **Offline**       | Works without internet                                           |
| **Cost**          | Free with local models                                           |
| **Private repos** | No policy concerns                                               |
| **Model choice**  | Local (HuggingFace, Ollama) or cloud (OpenAI, Anthropic, Google) |


---

## Use Cases

- **Private & sensitive code** – Work on proprietary or confidential projects without sending code to third parties
- **Offline development** – Code on planes, trains, or anywhere without reliable internet
- **Zero API cost** – Run local models and avoid per-token pricing
- **Air-gapped / restricted environments** – Deploy where cloud AI services aren’t allowed

---

## Quick Start

**Runs locally in minutes.** Prerequisites: [Node.js](https://nodejs.org/) (LTS), npm.

```bash
git clone https://github.com/BixbiteAI/LoCoPilot.git
cd LoCoPilot
npm install
./scripts/code.sh          # macOS/Linux — or scripts\code.bat on Windows
```

LoCoPilot compiles if needed, then launches. Add a local model in **LoCoPilot Settings** (Chat panel → model dropdown → Add Language Models) and start coding.

---

## Roadmap

- Improved local model discovery and one-click setup
- Broader model support (Ollama, LM Studio, etc.)
- Performance and latency improvements for inline suggestions
- Optional desktop installers for easier distribution

---

## Try it now


| Action                   | Link                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| ⭐ **Star**               | [GitHub](https://github.com/BixbiteAI/LoCoPilot)                                               |
| 🐛 **Report a bug**      | [Open an issue](https://github.com/BixbiteAI/LoCoPilot/issues/new?template=bug_report.md)      |
| 💡 **Request a feature** | [Open an issue](https://github.com/BixbiteAI/LoCoPilot/issues/new?template=feature_request.md) |
| 💬 **Discuss**           | [GitHub Discussions](https://github.com/BixbiteAI/LoCoPilot/discussions)                       |
| 🤝 **Contribute**        | [CONTRIBUTING.md](CONTRIBUTING.md)                                                             |


---

## Installation (detailed)

**macOS / Linux:**

```bash
./scripts/code.sh
```

**Windows:**

```bash
scripts\code.bat
```

**Development (auto-compile on save):** `npm run dev` or `./scripts/dev.sh`

---

## How to Use LoCoPilot

LoCoPilot supports **local and cloud** language models. Add models in **LoCoPilot Settings**, then choose which model to use in the **Chat** panel.

### Adding a model (local or cloud)

1. Open the **Chat** panel (activity bar or View menu).
2. In the chat header, open the **model dropdown** (current model name).
3. Click **"Add Language Models"**. This opens **LoCoPilot Settings** on the **Add Language Model** tab.
4. In LoCoPilot Settings:
  - **Model Type:** choose **Cloud** or **Local**.
  - **Model Provider:** Cloud (Anthropic, OpenAI, Google—API key required) or Local (HuggingFace, Localhost).
  - Fill in required fields (API key or token, model name/ID, etc.) and optional limits if needed.
  - Click **Add** to save.

### Using a model in chat

- In the **Chat** panel, open the **model dropdown**. All added models appear in the list.
- Select a model. Use **Ask** (chat only) or **Agent** (chat with tools: terminal, edits).

### Agent settings

In **LoCoPilot Settings** → **Agent Settings**:

- **Max iterations per request** – limit agent steps per request.
- **Auto approve terminal commands** – when on, agent terminal commands run without confirmation (sandboxed). Default: off.
- **System prompts** – customize prompts for **Agent** and **Ask** modes (Markdown supported).
- Use **Save**, **Cancel**, or **Restore to default** as needed.

Open LoCoPilot Settings from the model dropdown (**Add Language Models**) or via the command palette: **LoCoPilot Settings**.

---

## Bundled Extensions

LoCoPilot includes built-in extensions in the [extensions](extensions) folder (grammars, snippets, language support). Rich language features (inline suggestions, Go to Definition) use the `language-features` suffix.

---

## License

Copyright (c) 2015 - present Microsoft Corporation. All rights reserved.  
Copyright (c) Bixbite AI. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license. This project uses source code from the [MIT-licensed VS Code project](https://github.com/microsoft/vscode).