import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',timeout:45000,workers:1,use:{baseURL:'http://127.0.0.1:4175',viewport:{width:1440,height:1000},headless:true,channel:'chrome',launchOptions:{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}},webServer:{command:'npm run preview -- --port 4175 --strictPort',url:'http://127.0.0.1:4175',reuseExistingServer:true,timeout:20000}});

