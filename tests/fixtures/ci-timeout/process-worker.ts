process.send?.({ event: 'ready' });
process.on('message', (): void => {});
