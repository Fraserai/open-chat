# Open Chat

Your iPhone open-model chat app is in `mobile/`.

- Full implementation and setup: `mobile/README.md`
- iPhone project: `mobile/ios/OpenChat.xcodeproj`
- Model mappings: `mobile/model-map.json`
- Test/build status and remaining connections: `mobile/BUILD-STATUS.md`

From this folder, with Node 24 installed:

```sh
npm ci --ignore-scripts
npm run dev:local --prefix mobile
```

Open http://127.0.0.1:5174 on the same computer. To enable real replies, configure the server's funded inference key as described in the README. To use it on iPhone, deploy the backend and open the Xcode project on a Mac.

The package contains the complete HuggingChat source fork plus the mobile app, managed backend and Apple integration. It has not been deployed or submitted to the App Store. No provider credential or Apple account was supplied; no live inference/purchase was tested.
