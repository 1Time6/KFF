// The Next server uses the supervisor's IPC channel only to observe parent loss.
// Business actions belong to Agent guardians and their original durable journals.
if (!process.connected) throw new Error('A local supervisor IPC channel is required');
process.once('disconnect', () => process.exit(1));
