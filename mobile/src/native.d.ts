export {};
declare global {
	interface Window {
		webkit?: { messageHandlers: { native: { postMessage: (data: unknown) => void } } };
		nativeEvent?: (data: any) => void;
		SpeechRecognition: any;
		webkitSpeechRecognition: any;
	}
}
