export interface IAttributes {
  id: any;
}

export interface IEvent {
  topic: string;
  emitter: any;
  payload: any;
  options: any;
}

export interface INewable<T> {
    new(...params : any[]): T;
}
