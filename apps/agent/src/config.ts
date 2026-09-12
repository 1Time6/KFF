import {loadAgentConfiguration} from './configuration';
export const {runtimeDir,agentConfig}=loadAgentConfiguration(process.env.KFF_ROOT??process.cwd());
