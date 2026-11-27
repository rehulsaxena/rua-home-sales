import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'in.ruahome.sales',
    appName: 'RUA HOME Sales',
    webDir: 'www',
    server: {
          // Points the app straight at the live backend so the app always reflects
      // whatever is deployed on Render, with no separate copy of index.html to keep in sync.
      url: 'https://rua-home-sales.onrender.com',
          cleartext: false
    },
    android: {
          allowMixedContent: false
    }
};

export default config;
