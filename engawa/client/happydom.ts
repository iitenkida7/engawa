import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register with a concrete URL so window.location.host is populated; some
// modules (e.g. network.ts) derive the WS endpoint from it.
GlobalRegistrator.register({ url: 'http://localhost:5173' });
