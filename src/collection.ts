import * as _ from 'underscore';
import {Injectable, Output, EventEmitter} from '@angular/core';
import {Observable, Subject} from 'rxjs/Rx';

import * as mixin from './mixin';
import {Model} from './model'
import {IAttributes, IEvent, INewable} from './interface'
import {SObject} from './object'

// Default options for `Collection#set`.
var DEFAULT_SET_OPTIONS = {add: true, remove: true, merge: true};
var DEFAULT_ADD_OPTIONS = {add: true, remove: false};

// Splices `insert` into `array` at index `at`.
var splice = function(array, insert, at) {
  at = Math.min(Math.max(at, 0), array.length);
  var tail = Array(array.length - at);
  var length = insert.length;
  var i;
  for (i = 0; i < tail.length; i++) tail[i] = array[i + at];
  for (i = 0; i < length; i++) array[i + at] = insert[i];
  for (i = 0; i < tail.length; i++) array[i + length + at] = tail[i];
};

export class Collection<M extends SObject> extends SObject {
  protected model: INewable<M>;
  protected comparator: any;
  private length: number = 0;
  private _byId: any = {};

  constructor (models, options: any = {}) {
    super(options);
    this.model$ = new Subject<M>();
    if (options.model) this.model = options.model;
    if (options.comparator) this.comparator = options.comparator;
    this._reset();
    if (models) this.reset(models, _.extend({silent: true}, options));
  }

  // --------------------- Query String
  protected query: any = {};
  setQueryField(key: any, val: any, options: any = {}) : Collection<M> {
    if (key == null) return this;

    // Handle both `"key", value` and `{key: value}` -style arguments.
    var attrs;
    if (typeof key === 'object') {
      attrs = key;
    } else {
      (attrs = {})[key] = val;
    }
    var unset      = options.unset;

    for (var attr in attrs) {
      val = attrs[attr];
      unset ? delete this.query[attr] : this.query[attr] = val;
    }

    return this;
  }

  unsetQueryField(attr, options) {
    return this.setQueryField(attr, void 0, _.extend({}, options, {unset: true}));
  }

  // Model stream
  public model$: Subject<M>;

  // Models
  protected models: Array<M>

  get $models() {
    return this.models;
  }

  get models$() {
    return Observable.from(this.models);
  }

  // The JSON representation of a Collection is an array of the
  // models' attributes.
  toJSON(options: any = {}) {
    return _.map(this.models, model => model.toJSON(options));
  }

  // Add a model, or list of models to the set. `models` may be Backbone
  // Models or raw JavaScript objects to be converted to Models, or any
  // combination of the two.
  add(models: Array<M>, options: any = {}) {
    return this.set(models, _.extend(
      { merge: false }, options, DEFAULT_ADD_OPTIONS)
    );
  }

  // Remove a model, or a list of models from the set.
  remove(models, options: any = {}) {
    options = _.clone(options);
    var singular = !_.isArray(models);
    models = singular ? [models] : models.slice();
    var removed = this._removeModels(models, options);
    if (!options.silent && removed.length) {
      options.changes = {added: [], merged: [], removed: removed};
      this.event$.emit(<IEvent> {
        topic: 'update',
        emitter: this,
        options: options});
    }
    return singular ? removed[0] : removed;
  }

  // Update a collection by `set`-ing a new list of models, adding new ones,
  // removing models that are no longer present, and merging models that
  // already exist in the collection, as necessary. Similar to **Model#set**,
  // the core operation for updating the data contained by the collection.
  set(models: Array<M>, options: any = {}) {
    if (models == null) return;

    options = _.extend({}, DEFAULT_SET_OPTIONS, options);
    if (options.parse && !this._isModel(models)) {
      models = this.parse(models, options) || [];
    }

    var singular = !_.isArray(models);
    models = singular ? [ models ] : models.slice();

    var at = options.at;
    if (at != null) at = +at;
    if (at > this.length) at = this.length;
    if (at < 0) at += this.length + 1;

    var set = [];
    var toAdd = [];
    var toMerge = [];
    var toRemove = [];
    var modelMap = {};

    var add = options.add;
    var merge = options.merge;
    var remove = options.remove;

    var sort = false;
    var sortable = this.comparator && at == null && options.sort !== false;
    var sortAttr = _.isString(this.comparator) ? this.comparator : null;

    // Turn bare objects into model references, and prevent invalid models
    // from being added.
    var model, i;
    for (i = 0; i < models.length; i++) {
      model = models[i];

      // If a duplicate is found, prevent it from being added and
      // optionally merge it into the existing model.
      var existing = this.get(model);
      if (existing) {
        if (merge && model !== existing) {
          var attrs = this._isModel(model) ? model.attributes : model;
          if (options.parse) attrs = existing.parse(attrs, options);
          existing.set(attrs, options);
          toMerge.push(existing);
          if (sortable && !sort) sort = existing.hasChanged(sortAttr);
        }
        if (!modelMap[existing.cid]) {
          modelMap[existing.cid] = true;
          set.push(existing);
        }
        models[i] = existing;

      // If this is a new, valid model, push it to the `toAdd` list.
      } else if (add) {
        model = models[i] = this._prepareModel(model, options);
        if (model) {
          toAdd.push(model);
          this._addReference(model, options);
          modelMap[model.cid] = true;
          set.push(model);
        }
      }
    }

    // Remove stale models.
    if (remove) {
      for (i = 0; i < this.length; i++) {
        model = this.models[i];
        if (!modelMap[model.cid]) toRemove.push(model);
      }
      if (toRemove.length) this._removeModels(toRemove, options);
    }

    // See if sorting is needed, update `length` and splice in new models.
    var orderChanged = false;
    var replace = !sortable && add && remove;
    if (set.length && replace) {
      orderChanged = this.length !== set.length || _.some(this.models, function(m, index) {
        return m !== set[index];
      });
      this.models.length = 0;
      splice(this.models, set, 0);
      this.length = this.models.length;
    } else if (toAdd.length) {
      if (sortable) sort = true;
      splice(this.models, toAdd, at == null ? this.length : at);
      this.length = this.models.length;
    }

    // Silently sort the collection if appropriate.
    if (sort) this.sort({silent: true});

    // Unless silenced, it's time to fire all appropriate add/sort/update events.
    if (!options.silent) {
      for (i = 0; i < toAdd.length; i++) {
        if (at != null) options.index = at + i;
        model = toAdd[i];
        this.event$.emit(<IEvent> {
          topic: 'add',
          emitter: this,
          payload: model,
          options: options});
      }
      if (sort || orderChanged) this.event$.emit(<IEvent> {
        topic: 'sort',
        emitter: this,
        options: options});
      if (toAdd.length || toRemove.length || toMerge.length) {
        options.changes = {
          added: toAdd,
          removed: toRemove,
          merged: toMerge
        };
        this.event$.emit(<IEvent> {
          topic: 'update',
          emitter: this,
          options: options});
      }
    }

    _.each(models, m => this.model$.next(m));

    // Return the added (or merged) model (or models).
    return singular ? models[0] : models;
  }

  // When you have more items than you want to add or remove individually,
  // you can reset the entire set with a new list of models, without firing
  // any granular `add` or `remove` events. Fires `reset` when finished.
  // Useful for bulk operations and optimizations.
  reset(models, options) {
    options = options ? _.clone(options) : {};
    for (var i = 0; i < this.models.length; i++) {
      this._removeReference(this.models[i], options);
    }
    options.previousModels = this.models;
    this._reset();
    models = this.add(models, _.extend({silent: true}, options));
    if (!options.silent) this.event$.emit(<IEvent> {
      topic: 'reset',
      emitter: this,
      options: options});
    return models;
  }

  // Add a model to the end of the collection.
  push(model, options) {
    return this.add(model, _.extend({at: this.length}, options));
  }

  // Remove a model from the end of the collection.
  pop(options) {
    var model = this.at(this.length - 1);
    return this.remove(model, options);
  }

  // Add a model to the beginning of the collection.
  unshift(model, options) {
    return this.add(model, _.extend({at: 0}, options));
  }

  // Remove a model from the beginning of the collection.
  shift(options) {
    var model = this.at(0);
    return this.remove(model, options);
  }

  // Slice out a sub-array of models from the collection.
  slice() {
    return slice.apply(this.models, arguments);
  }

  // Get a model from the set by id, cid, model object with id or cid
  // properties, or an attributes object that is transformed through modelId.
  get(obj) {
    if (obj == null) return void 0;
    return this._byId[obj] ||
      this._byId[this.modelId(obj.attributes || obj)] ||
      obj.cid && this._byId[obj.cid];
  }

  // Returns `true` if the model is in the collection.
  has(obj) {
    return this.get(obj) != null;
  }

  // Get the model at the given index.
  at(index) {
    if (index < 0) index += this.length;
    return this.models[index];
  }

  // Return models with matching attributes. Useful for simple cases of
  // `filter`.
  where(attrs, first) {
    return this[first ? 'find' : 'filter'](attrs);
  }

  // Return the first model with matching attributes. Useful for simple cases
  // of `find`.
  findWhere(attrs) {
    return this.where(attrs, true);
  }

  // Force the collection to re-sort itself. You don't need to call this under
  // normal circumstances, as the set will maintain sort order as each item
  // is added.
  sort(options) {
    var comparator = this.comparator;
    if (!comparator) throw new Error('Cannot sort a set without a comparator');
    options || (options = {});

    var length = comparator.length;
    if (_.isFunction(comparator)) comparator = _.bind(comparator, this);

    // Run sort based on type of `comparator`.
    if (length === 1 || _.isString(comparator)) {
      this.models = this.sortBy(comparator);
    } else {
      this.models.sort(comparator);
    }
    if (!options.silent) this.event$.emit(<IEvent> {
        topic: 'sort',
        emitter: this,
        payload: comparator,
        options: options});
    return this;
  }

  // Pluck an attribute from each model in the collection.
  pluck(attr) {
    return this.map(attr + '');
  }

  // Fetch the default set of models for this collection, resetting the
  // collection when they arrive. If `reset: true` is passed, the response
  // data will be passed through the `reset` method instead of `set`.
  fetch(options: any = {}) {
    options = _.extend({parse: true}, options);

    let query = options.query || (options.query={});
    let thisCopy = _.clone(this);

    var url = options.url || _.result(this, 'url');

    var qsi = url.indexOf('?');
    if (qsi != -1) {
      _.extend(query, this.service.queryStringToParams(url.slice(qsi + 1)));
      options.url = url.slice(0, qsi);
    }

    // map query parameters
    let q = _.pairs(_.extend({}, this.query, query)),
        kvp,
        v;
    for (let i = 0; i < q.length; i++) {
      kvp = q[i];
      v = kvp[1];
      v = _.isFunction(v) ? v.call(thisCopy) : v;
      if (v != null) query[kvp[0]] = v;
    }

    let obs$ = this.sync('read', options);
    //TODO: El error
    obs$.subscribe(
      resp => {
          var method = options.reset ? 'reset' : 'set';
          this[method](resp, options);
    });
    return obs$;
  }

  // Create a new instance of a model in this collection. Add the model to the
  // collection immediately, unless `wait: true` is passed, in which case we
  // wait for the server to agree.
  create(model, options = {}) {
    var wait = options.wait;
    model = this._prepareModel(model, options);
    if (!model) return false;
    if (!wait) this.add(model, options);
    let obs$ = model.save(null, options);
    obs$.subscribe(
      resp => {
        if (wait) this.add(m, callbackOpts);
      }
    );
    return model;
  }

  // **parse** converts a response into a list of models to be added to the
  // collection. The default implementation is just to pass it through.
  parse(resp, options) {
    return resp;
  }

  // Create a new collection with an identical list of models as this one.
  clone() {
    return this.service.createCollection(this.models, {
      comparator: this.comparator
    });
  }

  // Define how to uniquely identify models in the collection.
  modelId(attrs) {
    return this.service.modelId(attrs);
  }

  // Private method to reset all internal state. Called when the collection
  // is first initialized or reset.
  _reset() {
    this.length = 0;
    this.models = [];
    this._byId  = {};
  }

  // Prepare a hash of attributes (or other model) to be added to this
  // collection.
  _prepareModel(attrs, options) {
    if (this._isModel(attrs)) {
      if (!attrs.collection) attrs.collection = this;
      return attrs;
    }
    options = options ? _.clone(options) : {};
    options.collection = this;
    var model = this.service.createModel(attrs, options);
    if (!model.validationError) return model;
    this.event$.emit(<IEvent> {
      topic: 'invalid',
      emitter: this,
      payload: model.validationError,
      options:options});
    return false;
  }

  // Internal method called by both remove and set.
  _removeModels(models, options) {
    var removed = [];
    for (var i = 0; i < models.length; i++) {
      var model = this.get(models[i]);
      if (!model) continue;

      var index = this.indexOf(model);
      this.models.splice(index, 1);
      this.length--;

      // Remove references before triggering 'remove' event to prevent an
      // infinite loop. #3693
      delete this._byId[model.cid];
      var id = this.modelId(model.attributes);
      if (id != null) delete this._byId[id];

      if (!options.silent) {
        options.index = index;
        model.event$.emit(<IEvent> {
          topic:'remove',
          model: model,
          payload: this,
          options: options});
      }

      removed.push(model);
      this._removeReference(model, options);
    }
    return removed;
  }

  // Method for checking whether an object should be considered a model for
  // the purposes of adding to the collection.
  _isModel(model) {
    return model instanceof Model;
  }

  // Internal method to create a model's ties to a collection.
  _addReference(model, options) {
    this._byId[model.cid] = model;
    var id = this.modelId(model.attributes);
    if (id != null) this._byId[id] = model;
    model.event$.subscribe(event=> this._onModelEvent(event));
  }

  // Internal method to sever a model's ties to a collection.
  _removeReference(model, options) {
    delete this._byId[model.cid];
    var id = this.modelId(model.attributes);
    if (id != null) delete this._byId[id];
    if (this === model.collection) delete model.collection;
    //TODO: Los unsubsribe
    //model.off('all', this._onModelEvent, this);
  }

  // Internal method called every time a model in the set fires an event.
  // Sets need to update their indexes when models change ids. All other
  // events simply proxy through. "add" and "remove" events that originate
  // in other collections are ignored.
  _onModelEvent(event) {
    if (event.emitter) {
      if ((event.topic === 'add' || event.topic === 'remove') && event.payload !== this) return;
      if (event.topic === 'destroy') this.remove(event.emitter, event.options);
      if (event.topic === 'change') {
        var prevId = this.modelId(event.emitter.previousAttributes());
        var id = this.modelId(event.emitter.attributes);
        if (prevId !== id) {
          if (prevId != null) delete this._byId[prevId];
          if (id != null) this._byId[id] = event.model;
        }
      }
    }
    this.event$.emit(event);
  }
}

// Underscore methods that we want to implement on the Collection.
// 90% of the core usefulness of Backbone Collections is actually implemented
// right here:
var collectionMethods = {forEach: 3, each: 3, map: 3, collect: 3, reduce: 0,
      foldl: 0, inject: 0, reduceRight: 0, foldr: 0, find: 3, detect: 3, filter: 3,
      select: 3, reject: 3, every: 3, all: 3, some: 3, any: 3, include: 3, includes: 3,
      contains: 3, invoke: 0, max: 3, min: 3, toArray: 1, size: 1, first: 3,
      head: 3, take: 3, initial: 3, rest: 3, tail: 3, drop: 3, last: 3,
      without: 0, difference: 0, indexOf: 3, shuffle: 1, lastIndexOf: 3,
      isEmpty: 1, chain: 1, sample: 3, partition: 3, groupBy: 3, countBy: 3,
      sortBy: 3, indexBy: 3, findIndex: 3, findLastIndex: 3};

// Mix in each Underscore method as a proxy to `Collection#models`.
mixin.addUnderscoreMethods(Collection, collectionMethods, 'models');
