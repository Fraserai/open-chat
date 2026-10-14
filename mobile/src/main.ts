import { mount } from "svelte";
// The original full app is still in App.svelte (with style.css) — swap these two imports back to use it.
import GlassChat from "./GlassChat.svelte";
import "./glass.css";
mount(GlassChat, { target: document.getElementById("app")! });
