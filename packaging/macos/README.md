# FPA for macOS

Install `FPA.app` by dragging it into Applications. FPA starts a local service and opens the workspace in the default browser. A small `FPA` menu remains in the macOS menu bar while the service is running.

Local assets, generation history, settings, and logs are stored in:

```text
~/Library/Application Support/FPA
```

API keys are not included in the installer. Configure them in FPA System Settings on each Mac.

This development build is ad-hoc signed but not notarized with an Apple Developer ID. On first launch, Control-click `FPA.app`, choose **Open**, then confirm. Production distribution should use Developer ID signing and Apple notarization.
