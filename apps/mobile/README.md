# Flutter client

This is a source client, not a signed Android/iOS release. Flutter tooling is required to generate platform runners:

```bash
cd apps/mobile
flutter create --platforms=android,ios --project-name streamforge_mobile .
flutter pub get
flutter analyze
flutter run --dart-define=API_URL=https://your-domain/api/v1
```

Preserve the supplied `lib/` and `pubspec.yaml` if your Flutter version offers to replace them. Enable Android INTERNET permission and configure the iOS application transport policy for your development endpoint. Production must use HTTPS. The example API URL targets the Android emulator; physical devices require a reachable HTTPS hostname. PUBLIC_URL in the backend must also be reachable from the device.

Implemented source flows: verified-account login, secure refresh-token storage, workspace switch, metadata cache, resumable foreground uploads with persisted upload IDs and chunk retries, pause after the current chunk, HLS native playback, saved watch position, basic analytics, refreshable processing state.

Not claimed: OS background upload service, subtitle selection UI, push notifications, offline action replay, automatic processing SSE on mobile, App Store/Play release configuration. These need device testing and platform-specific work. Reselect the same file after process termination to resume; its SHA-256 identifies the server session. Cached metadata is device-local; clear app data when handing a device to another person.
