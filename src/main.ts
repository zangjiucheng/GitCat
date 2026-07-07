// Frontend entry. Boot the legacy vanilla app (side-effect import: it builds the
// canvas, sidebar, drawer, mascot and starts the RAF loop), then mount the
// Svelte islands over the DOM. Islands render their own scrim markup into
// <body>, so the old #conflictScrim / #bisectScrim blocks are gone from the HTML.
import "./legacy/main.ts";
import { mount } from "svelte";
import Resolver from "./islands/resolver/Resolver.svelte";
import Bisect from "./islands/bisect/Bisect.svelte";

mount(Resolver, { target: document.body });
mount(Bisect, { target: document.body });
