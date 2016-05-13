import * as _ from 'underscore';
import {RequestMethod} from '@angular/http';
import {EventEmitter} from '@angular/core';
import {IEvent} from './interface';

export class SObject {
  protected urlRoot: string;
  protected service: any;

  // Events
  public event$: EventEmitter<IEvent> = new EventEmitter<IEvent>();

  // Status
  public $status = {
    deleting: false,
    loading: false,
    saving: false,
    syncing: false
  }

  public _setStatus(key, value?, options = {}) {
    var attr, attrs;

    if (_.isUndefined(key))
      return this;

    if (_.isObject(key)) {
      attrs = key;
      options = value;
    } else {
      (attrs = {})[key] = value;
    }

    for (attr in this.$status) {
      if (attrs.hasOwnProperty(attr) && _.isBoolean(attrs[attr])) {
        this.$status[attr] = attrs[attr];
      }
    }
  }

  public _resetStatus() {
    return this._setStatus({
      deleting: false,
      loading:  false,
      saving:   false,
      syncing:  false
    });
  }

  constructor (options : any = {}) {
    this.event$.filter(e => e.topic == 'request')
      .subscribe(
        e => this._setStatus({
          deleting: (e.options.method === RequestMethod.Delete),
          loading: (e.options.method === RequestMethod.Get),
          saving: (e.options.method === RequestMethod.Post || e.options.method === RequestMethod.Put),
          syncing:  true
        }));
    this.event$.filter(e => _.contains(['sync', 'error'], e.topic))
        .subscribe(e => this._resetStatus());
    if (options.service) this.service = options.service;
  }

  url() : string {
    return 	_.result(this, 'urlRoot') ||
      _.result(this.service, 'url') ||
      this.event$.emit(<IEvent> {
        topic: 'error',
        emitter: this});
  }

  // Return a json representation of the object
  toJSON (options: any = {}) {}

  // Synchronized object is not new
  isNew() { return false; }

  // Proxy `Service.sync` by default -- but override this if you need
  // custom syncing semantics for *this* particular object.
  sync(method: string, options?) {
    let obs$ = this.service.sync(method, this, options);
    obs$.subscribe(resp => {
      if (!this.isNew()) this.event$.emit(<IEvent> {
        topic: 'sync',
        emitter: this,
        payload: resp,
        options: options});
    });
    return obs$
  }
}
