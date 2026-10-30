<div align="center">

# astro

**autonomous terminal-native developer ai agent**

[![Release](https://img.shields.io/github/v/release/cyberuz001/astro-cli?color=ea580c&label=version&style=flat-square)](https://github.com/cyberuz001/astro-cli/releases)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-22c55e?style=flat-square)](https://github.com/cyberuz001/astro-cli)
[![License](https://img.shields.io/badge/license-proprietary-neutral?style=flat-square)](https://github.com/cyberuz001/astro-cli)

</div>

---

### quick install

#### windows (powershell)
```powershell
irm https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.ps1 | iex
```

#### linux & macos
```bash
curl -fsSL https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.sh | bash
```

---

### model taxonomy

Astro maps Flash to Photon, Argon to Nebula, and Opus to Vortex. Photon 3.8
is Gemini 3.8 Flash. `vortex` follows the newest available Opus version;
`nebula` follows the newest available Argon only. Without Argon access it is
absent; Gemini Pro is listed under its own provider name. Versioned models stay pinned.
Argon and other new model families are discovered from Google's catalog.
Family selectors are configured in `cli/models.json`.

`vortex` recognizes major-only versions (such as a hypothetical Opus 5) and
minor versions; this parsing is regression-tested, not a launch announcement.
Model catalog refresh does not update the CLI executable. Current installers
disable the native updater and its notification; software update delivery has
not yet been verified and is not advertised as working.

Use `/effort low`, `/effort medium`, `/effort high`, or `/model photon-3.8 high`.
Each model exposes only its supported reasoning levels, and the proxy routes
that selection to an effort variant, thinking level, or thinking budget.
Unsupported levels return HTTP 400. Tool calls, results, and opaque thinking
signatures are preserved across turns and proxy restarts (512 recent calls).

The proxy checks Google's authenticated model catalog every 60 seconds.
Removed backends disappear along with all their aliases, and that state is
cached across restarts. Network failures retain the previous catalog;
exhausted quota does not remove a model. The terminal picker uses this live
list and also refreshes every 60 seconds. Existing `allowed_models` settings
can still restrict new models.

Google account access is verified with `loadCodeAssist` (`paidTier` takes
precedence). Pro/Ultra-only models are absent from the terminal when the
account is not entitled. Explicit model restrictions, account ineligibility,
subscription denials, downgrades, expired credentials, and logout invalidate
cached access. Model family names do not establish subscription requirements.
Login uses the account's managed project and waits for onboarding completion;
profile/onboarding/persistence failures cannot redirect to the success page.

After a successful Google login is saved, the browser redirects to
`https://www.astroai.uz/auth/success` without sending tokens to the website.

---

### themes

- `astronight` — obsidian dark aesthetic with vivid flame accents *(default)*.
- `astroday` — clean, high-contrast light theme for bright workspaces.

---

### usage

Launch interactive session:
```bash
astro
```

Switch active models:
```bash
/models
```

Refresh the installed proxy and launcher with the installer:

Windows PowerShell:
```bash
irm https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.ps1 | iex
```

Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.sh | bash
```

The native executable remains at the published release version. A new native
updater build has not been released; `astro update` is not yet a verified upgrade path.

---

<div align="center">
<sub>proprietary © 2026 astro. all rights reserved.</sub>
</div>
