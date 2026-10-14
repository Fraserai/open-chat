/**
 * Background drone shots for the home screen.
 *
 * To add your own: drop an .mp4 (and optionally a .jpg poster) into `mobile/public/backgrounds/`
 * and add a line below, e.g. shot("my-shot", "My shot"). See public/backgrounds/README.md for formats.
 *
 * Default clips: Mixkit (https://mixkit.co), free under the Mixkit License.
 */
export type Background = { id: string; name: string; src: string; poster?: string };

const shot = (file: string, name: string): Background => ({
	id: file,
	name,
	src: `/backgrounds/${file}.mp4`,
	poster: `/backgrounds/${file}.jpg`,
});

export const backgrounds: Background[] = [
	shot("archipelago", "Archipelago"),
	shot("rocky-island", "Rocky island"),
	shot("peninsula", "Peninsula"),
	shot("sea-at-sunset", "Sea at sunset"),
];
