import * as _ from 'underscore';
import {EventEmitter} from '@angular/core';
import * as mixin from './mixin';
import {IAttributes, IEvent} from './interface';
import {Synchronizable} from './synchronizable';
import {Observable} from 'rxjs/Rx';

export class Model<A extends IAttributes> extends Synchronizable {
  public id: any;
  public cid: any;
  protected idAttribute: string = 'id';
  protected cidPrefix: string = 'c';
  protected _url: string;
  protected _changing: boolean;
  protected _pending: boolean;
  protected validationError: any;

  constructor (attrs: any = <A> {}, options : any = {}) {
    super(options);
    // For clearing status when destroy model on collection
    this.event$.filter(e => e.topic == 'destroy')
        .subscribe(e => this._resetStatus());
    this.cid = _.uniqueId(this.cidPrefix);
    if (options.parse) attrs = this.parse(attrs, options) || <A> {};
    let defaults = _.result(this, 'defaults');
    attrs = _.defaults(_.extend({}, defaults, attrs), defaults);
    this.set(attrs, options);
  }

  // Attributes
  protected attributes: A = <A> {};
  protected defaults: A;
  protected _previousAttributes: A;
  protected changed: A = <A> {};
  public $attributes = new Proxy(this.attributes, {
    get: (target, property, receiver) => this.get(property),
    set: (target, property, value, receiver) => this.set(property, value)
  })

  url() : string {
    let base = super.url();
    if (this.isNew()) return base;
    let id = this.get(this.idAttribute);
    return base.replace(/[^\/]$/, '$&/') + encodeURIComponent(id);
  }

  get(attr: string) : any {
    return this.attributes[attr];
  }

  // Get the HTML-escaped value of an attribute.
  escape(attr) {
    return _.escape(this.get(attr));
  }

  // Returns `true` if the attribute contains a value that is not null
  // or undefined.
  has(attr) {
    return this.get(attr) != null;
  }

  // Special-cased proxy to underscore's `_.matches` method.
  matches(attrs) {
    return !!_.iteratee(attrs, this)(this.attributes);
  }

  set(key: any, val: any, options: any = {}) : Model<A> {
    if (key == null) return this;

    // Handle both `"key", value` and `{key: value}` -style arguments.
    var attrs;
    if (typeof key === 'object') {
      attrs = key;
      options = val;
    } else {
      (attrs = {})[key] = val;
    }

    // Run validation.
    if (!this._validate(attrs, options)) return this;

    // Extract attributes and options.
    var unset      = options.unset;
    var silent     = options.silent;
    var changes    = [];
    var changing   = this._changing;
    this._changing = true;

    if (!changing) {
      this._previousAttributes = _.clone(this.attributes);
      this.changed = <A> {};
    }

    var current = this.attributes;
    var changed = this.changed;
    var prev    = this._previousAttributes;

    // For each `set` attribute, update or delete the current value.
    for (var attr in attrs) {
      val = attrs[attr];
      if (!_.isEqual(current[attr], val)) changes.push(attr);
      if (!_.isEqual(prev[attr], val)) {
        changed[attr] = val;
      } else {
        delete changed[attr];
      }
      unset ? delete current[attr] : current[attr] = val;
    }

    // Update the `id`.
    if (this.idAttribute in attrs) this.id = this.get(this.idAttribute);

    // Trigger all relevant attribute changes.
    if (!silent) {
      if (changes.length) this._pending = options;
      for (var i = 0; i < changes.length; i++) {
        this.event$.emit(<IEvent> {
          topic: 'change:' + changes[i],
          emitter: this,
          payload: current[changes[i]],
          options: options});
      }
    }

    // You might be wondering why there's a `while` loop here. Changes can
    // be recursively nested within `"change"` events.
    if (changing) return this;
    if (!silent) {
      while (this._pending) {
        options = this._pending;
        this._pending = false;
        this.event$.emit(<IEvent> {
            topic: 'change',
            emitter: this,
            options: options
          });
        }
      }
    this._pending = false;
    this._changing = false;
    return this;
  }

  // Return a copy of the model's `attributes` object.
  toJSON (options?: any) {
    return _.clone(this.attributes);
  }

  // Remove an attribute from the model, firing `"change"`. `unset` is a noop
  // if the attribute doesn't exist.
  unset(attr, options) {
    return this.set(attr, void 0, _.extend({}, options, {unset: true}));
  }

  // Clear all attributes on the model, firing `"change"`.
  clear(options) {
    var attrs = {};
    for (var key in this.attributes) attrs[key] = void 0;
    return this.set(attrs, _.extend({}, options, {unset: true}));
  }

  // Determine if the model has changed since the last `"change"` event.
  // If you specify an attribute name, determine if that attribute has changed.
  hasChanged(attr?) : boolean {
    if (attr == null) return !_.isEmpty(this.changed);
    return _.has(this.changed, attr);
  }

  // Return an object containing all the attributes that have changed, or
  // false if there are no changed attributes. Useful for determining what
  // parts of a view need to be updated and/or what attributes need to be
  // persisted to the server. Unset attributes will be set to undefined.
  // You can also pass an attributes object to diff against the model,
  // determining if there *would be* a change.
  changedAttributes(diff) {
    if (!diff) return this.hasChanged() ? _.clone(this.changed) : false;
    var old = this._changing ? this._previousAttributes : this.attributes;
    var changed = {};
    for (var attr in diff) {
      var val = diff[attr];
      if (_.isEqual(old[attr], val)) continue;
      changed[attr] = val;
    }
    return _.size(changed) ? changed : false;
  }

  // Get the previous value of an attribute, recorded at the time the last
  // `"change"` event was fired.
  previous(attr) {
    if (attr == null || !this._previousAttributes) return null;
    return this._previousAttributes[attr];
  }

  // Get all of the attributes of the model at the time of the previous
  // `"change"` event.
  previousAttributes() {
    return _.clone(this._previousAttributes);
  }

  // Fetch the model from the server, merging the response with the model's
  // local attributes. Any changed attributes will trigger a "change" event.
  fetch(options: any = {}) : Observable<Model<A>> {
    options = _.extend({parse: true}, options);
    let obs$ = this.sync('read', options);
    obs$.subscribe(
      resp => {
        var serverAttrs = options.parse ? this.parse(resp, options) : resp;
        if (!this.set(serverAttrs, options)) return false;
      },
      err => this.event$.emit(<IEvent> {
        topic: 'error',
        emitter: this,
        payload: err,
        options: options})
      );
    return obs$;
  }

  // Set a hash of model attributes, and sync the model to the server.
  // If the server returns an attributes hash that differs, the model's
  // state will be `set` again.
  save(key, val, options?) : Observable<Model<A>> {
    // Handle both `"key", value` and `{key: value}` -style arguments.
    let attrs;
    if (key == null || typeof key === 'object') {
      attrs = key;
      options = val;
    } else {
      (attrs = {})[key] = val;
    }

    options = _.extend({validate: true, parse: true}, options);
    let wait = options.wait;

    // If we're not waiting and attributes exist, save acts as
    // `set(attr).save(null, opts)` with validation. Otherwise, check if
    // the model will be valid when the attributes, if any, are set.
    if (attrs && !wait) {
      if (!this.set(attrs, options)) return Observable.empty<Model<A>>();
    } else if (!this._validate(attrs, options)) {
      return Observable.empty<Model<A>>();
    }

    let attributes = this.attributes;

    // Set temporary attributes if `{wait: true}` to properly find new ids.
    if (attrs && wait) this.attributes = _.extend({}, attributes, attrs);

    let method = this.isNew() ? 'create' : (options.patch ? 'patch' : 'update');
    if (method === 'patch' && !options.attrs) options.attrs = attrs;
    let obs$ = this.sync(method, options);

    // After a successful server-side save, the client is (optionally)
    // updated with the server-side state.
    obs$.subscribe(
      resp => {
        // Ensure attributes are restored during synchronous saves.
        this.attributes = attributes;
        var serverAttrs = options.parse ? this.parse(resp, options) : resp;
        if (wait) serverAttrs = _.extend({}, attrs, serverAttrs);
        if (serverAttrs && !this.set(serverAttrs, options)) return false;
      },
      err => this.event$.emit(<IEvent> {
        topic: 'error',
        emitter: this,
        payload: err,
        options: options})
    );

    // Restore attributes.
    this.attributes = attributes;

    return obs$;
  }

  // Destroy this model on the server if it was already persisted.
  // If `wait: true` is passed, waits for the server to respond before removal.
  destroy(options) : Observable<Model<A>> {
    options = options ? _.clone(options) : {};
    var wait = options.wait;

    var destroy = () => {
      this.event$.emit(<IEvent>{
        topic: 'destroy',
        emitter: this,
        payload: this.service,
        options: options});
    }

    var obs$ = Observable.empty<Model<A>>();
    if (!this.isNew())
      obs$ = this.sync('delete', options);
    obs$.subscribe(
      resp => {
        if (wait) destroy();
      },
      err => this.event$.emit(<IEvent> {
        topic: 'error',
        emitter: this,
        payload: err,
        options: options})
      );
    if (!wait) destroy();
    return obs$;
  }

  // **parse** converts a response into the hash of attributes to be `set` on
  // the model. The default implementation is just to pass the response along.
  parse(resp, options?) : A {
    return resp;
  }

  validate(attrs, options) {
  }

  // Create a new model with identical attributes to this one.
  clone() : Model<A> {
    return this.service.createModel(this.attributes);
  }

  // A model is new if it has never been saved to the server, and lacks an id.
  isNew() : boolean {
    return !this.has(this.idAttribute);
  }
  // Check if the model is currently in a valid state.
  isValid(options) {
    return this._validate({}, _.extend({}, options, {validate: true}));
  }

  // Run validation against the next complete set of model attributes,
  // returning `true` if all is well. Otherwise, fire an `"invalid"` event.
  _validate(attrs, options) {
    if (!options.validate || !this.validate) return true;
    attrs = _.extend({}, this.attributes, attrs);
    var error = this.validationError = this.validate(attrs, options) || null;
    if (!error) return true;
    this.event$.emit(<IEvent> {
      topic: 'invalid',
      emitter: this,
      payload: error,
      options: _.extend(options, {validationError: error}) }
    );
    return false;
  }
}

// Underscore methods that we want to implement on the Model, mapped to the
// number of arguments they take.
var modelMethods = {keys: 1, values: 1, pairs: 1, invert: 1, pick: 0,
      omit: 0, chain: 1, isEmpty: 1};

// Mix in each Underscore method as a proxy to `Model#attributes`.
mixin.addUnderscoreMethods(Model, modelMethods, 'attributes');
