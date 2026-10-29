import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { installMap } from '@/world/map-data';
import office from '@maps/office_medium.json';

// Register with a concrete URL so window.location.host is populated; some
// modules (e.g. network.ts) derive the WS endpoint from it.
GlobalRegistrator.register({ url: 'http://localhost:5173' });

// The app fetches its map from the server before loading the world (core/boot.ts);
// tests build the world from the bundled office map instead.
installMap(structuredClone(office));
