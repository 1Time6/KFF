CREATE UNIQUE INDEX agent_single_execution_slot ON kff.agent_commands(agent_id) WHERE state IN ('READY','CLAIMED');
