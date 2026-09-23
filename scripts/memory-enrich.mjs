#!/usr/bin/env node
import {enrichMemory} from '../src/memory/enrich.mjs';
try { console.log(JSON.stringify(await enrichMemory())); }
catch(error) { console.log(JSON.stringify({status:'blocked',reason:'memory_enrichment',detail:error.name})); process.exitCode=1; }
