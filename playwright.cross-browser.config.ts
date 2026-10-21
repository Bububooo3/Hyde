import {defineConfig} from '@playwright/test';
import base from './playwright.config';

const {channel: _chromeChannel,launchOptions: _chromeLaunchOptions,...sharedUse}=base.use??{};

/** Small real-engine smoke pass; the main Chrome suite remains the fast baseline. */
export default defineConfig({
  ...base,
  use:sharedUse,
  testMatch:'cross-browser-smoke.spec.ts',
  projects:[
    {name:'edge',use:{browserName:'chromium',channel:'msedge',launchOptions:{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}}},
    {name:'firefox',use:{browserName:'firefox'}},
    {name:'webkit',use:{browserName:'webkit'}},
  ],
});
