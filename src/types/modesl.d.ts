declare module 'modesl' {
  export class Connection {
    constructor(host: string, port: number, password: string, onConnect?: () => void);
    api(command: string, callback?: (res: any) => void): void;
    bgapi(command: string, callback?: (res: any) => void): void;
    subscribe(events: string | string[], callback?: () => void): void;
    on(event: string, handler: (...args: any[]) => void): void;
    disconnect(): void;
  }
}
