import * as _ from 'underscore';
import {Injectable, Output, EventEmitter} from '@angular/core';
import {Http, Response} from '@angular/http';
import {Headers, URLSearchParams} from '@angular/http';
import {Observable, Observer, Subject} from 'rxjs/Rx';

import {IEvent} from './interface';
import {Collection} from './collection';
import {Model} from './model';

var _extend = _.extend;
var _omit = _.omit;
var _clone = _.clone;
var _each = _.each;
var _pick = _.pick;
var _contains = _.contains;
var _isEmpty = _.isEmpty;
var _pairs = _.pairs;
var _invert = _.invert;
var _isArray = _.isArray;
var _isFunction = _.isFunction;
var _isObject = _.isObject;
var _keys = _.keys;
var _isUndefined = _.isUndefined;
var ceil = Math.ceil;
var floor = Math.floor;
var max = Math.max;

function finiteInt (val, name) {
  if (!_.isNumber(val) || _.isNaN(val) || !_.isFinite(val) || ~~val !== val) {
    throw new TypeError("`" + name + "` must be a finite integer");
  }
  return val;
}

// hack to make sure the whatever event handlers for this event is run
// before func is, and the event handlers that func will trigger.
function runOnceAtLastHandler (col, event, func) {
  var eventHandlers = col._events[event];
  if (eventHandlers && eventHandlers.length) {
    var lastHandler = eventHandlers[eventHandlers.length - 1];
    var oldCallback = lastHandler.callback;
    lastHandler.callback = function () {
      try {
        oldCallback.apply(this, arguments);
        func();
      }
      catch (e) {
        throw e;
      }
      finally {
        lastHandler.callback = oldCallback;
      }
    };
  }
  else func();
}

var PARAM_TRIM_RE = /[\s'"]/g;
var URL_TRIM_RE = /[<>\s'"]/g;


/**
 * State change event. Fired when PageableCollection#state gets updated
 *
 * @event pageable:state:change
 * @type {object} The PageableCollection#state object of this
 * PageableCollection instance
 */


/**
   Drop-in replacement for Backbone.Collection. Supports server-side and
   client-side pagination and sorting. Client-side mode also support fully
   multi-directional synchronization of changes between pages.

   @class PageableCollection
   @extends Backbone.Collection
*/
export class PageableCollection<M> extends Collection {
  page$: Subject<M[]>;

  /**
     The container object to store all pagination states.

     You can override the default state by extending this class or specifying
     them in an `options` hash to the constructor.

     @property {number} firstPage = 1 - The first page index. Set to 0 if
     your server API uses 0-based indices. You should only override this value
     during extension, initialization or reset by the server after
     fetching. This value should be read only at other times.

     @property {number} lastPage = null - The last page index. This value
     is __read only__ and it's calculated based on whether `firstPage` is 0 or
     1, during bootstrapping, fetching and resetting. Please don't change this
     value under any circumstances.

     @property {number} currentPage = null - The current page index. You
     should only override this value during extension, initialization or reset
     by the server after fetching. This value should be read only at other
     times. Can be a 0-based or 1-based index, depending on whether
     `firstPage` is 0 or 1. If left as default, it will be set to `firstPage`
     on initialization.

     @property {number} pageSize = 25 - How many records to show per
     page. This value is __read only__ after initialization, if you want to
     change the page size after initialization, you must call
     PageableCollection#setPageSize.

     @property {number} totalPages = null - How many pages there are. This
     value is __read only__ and it is calculated from `totalRecords`.

     @property {number} totalRecords = null - How many records there
     are. This value is __required__ under server mode. This value is optional
     for client mode as the number will be the same as the number of models
     during bootstrapping and during fetching, either supplied by the server
     in the metadata, or calculated from the size of the response.

     @property {string} sortKey = null - The model attribute to use for
     sorting.

     @property {number} order = -1 - The order to use for sorting. Specify
     -1 for ascending order or 1 for descending order. If 0, no client side
     sorting will be done and the order query parameter will not be sent to
     the server during a fetch.
  */
  protected state: any = {
    firstPage: 1,
    lastPage: null,
    currentPage: null,
    pageSize: 25,
    totalPages: null,
    totalRecords: null,
    sortKey: null,
    order: -1
  };

  /**
     @property {string} mode = "server" The mode of operations for this
     collection. `"server"` paginates on the server-side, `"client"` paginates
     on the client-side and `"infinite"` paginates on the server-side for APIs
     that do not support `totalRecords`.
  */
  protected mode: string = "server";

  /**
     A translation map to convert PageableCollection state attributes
     to the query parameters accepted by your server API.

     You can override the default state by extending this class or specifying
     them in `options.queryParams` object hash to the constructor.

     @property {string} currentPage = "page"
     @property {string} pageSize = "per_page"
     @property {string} totalPages = "total_pages"
     @property {string} totalRecords = "total_entries"
     @property {string} sortKey = "sort_by"
     @property {string} order = "order"
     @property {string} directions = {"-1": "asc", "1": "desc"} - A map for
     translating a PageableCollection#state.order constant to the ones your
     server API accepts.
  */
  protected queryParams = {
    currentPage: "page",
    pageSize: "per_page",
    totalPages: "total_pages",
    totalRecords: "total_entries",
    sortKey: "sort_by",
    order: "order",
    directions: {
      "-1": "asc",
      "1": "desc"
    }
  };

  /**
     Given a list of models or model attributues, bootstraps the full
     collection in client mode or infinite mode, or just the page you want in
     server mode.

     If you want to initialize a collection to a different state than the
     default, you can specify them in `options.state`. Any state parameters
     supplied will be merged with the default. If you want to change the
     default mapping from PageableCollection#state keys to your server API's
     query parameter names, you can specifiy an object hash in
     `option.queryParams`. Likewise, any mapping provided will be merged with
     the default. Lastly, all Collection constructor options are also
     accepted.

     See:

     - PageableCollection#state
     - PageableCollection#queryParams
     - [Collection#initialize](http://backbonejs.org/#Collection-constructor)

     @constructor

     @property {Collection} fullCollection - __CLIENT MODE ONLY__
     This collection is the internal storage for the bootstrapped or fetched
     models. You can use this if you want to operate on all the pages.

     @param {Array.<Object>} models

     @param {Object} options

     @param {function(*, *): number} options.comparator - If specified, this
     comparator is set to the current page under server mode, or the
     PageableCollection#fullCollection otherwise.

     @param {boolean} options.full 0 If `false` and either a
     `options.comparator` or `sortKey` is defined, the comparator is attached
     to the current page. Default is `true` under client or infinite mode and
     the comparator will be attached to the PageableCollection#fullCollection.

     @param {Object} options.state - The state attributes overriding the defaults.

     @param {string} options.state.sortKey - The model attribute to use for
     sorting. If specified instead of `options.comparator`, a comparator will
     be automatically created using this value, and optionally a sorting order
     specified in `options.state.order`. The comparator is then attached to
     the new collection instance.

     @param {number} options.state.order - The order to use for sorting. Specify
     -1 for ascending order and 1 for descending order.

     @param {Object} options.queryParam
  */
  constructor (models, options: any = {}) {

    super(models, options);

    var mode = this.mode = options.mode || this.mode;

    var queryParams = _extend({}, this.queryParams, options.queryParams || {});

    queryParams.directions = _extend({},
                                     this.queryParams.directions,
                                     queryParams.directions);

    this.queryParams = queryParams;

    var state = this.state = _extend({}, this.state, options.state);

    state.currentPage = state.currentPage == null ?
      state.firstPage :
      state.currentPage;

    if (!_isArray(models)) models = models ? [models] : [];
    models = models.slice();

    if (mode != "server" && state.totalRecords == null && !_isEmpty(models)) {
      state.totalRecords = models.length;
    }

    this.switchMode(mode, _extend({fetch: false,
                                   resetState: false,
                                   models: models}, options));

    var comparator = options.comparator;

    if (state.sortKey && !comparator) {
      this.setSorting(state.sortKey, state.order, options);
    }

    if (mode != "server") {
      var fullCollection = this.fullCollection;

      if (comparator && options.full) {
        this.comparator = null;
        fullCollection.comparator = comparator;
      }

      if (options.full) fullCollection.sort();

      // make sure the models in the current page and full collection have the
      // same references
      if (!_isEmpty(models)) {
        this.reset(models, _extend({silent: true}, options));
        this.getPage(state.currentPage);
        models.splice.apply(models, [0, models.length].concat(this.models));
      }
    }

    this._initState = _clone(this.state);
  }

  /**
     Makes a Collection that contains all the pages.

     @private
     @param {Array.<Object|Model>} models
     @param {Object} options Options for Collection constructor.
     @return {Collection}
  */
  _makeFullCollection (models, options: any = {}) {

    var properties = ["url", "model", "sync", "comparator", "service"];
    var thisProto = this.constructor.prototype;
    var i, length, prop;

    var proto = {};
    for (i = 0, length = properties.length; i < length; i++) {
      prop = properties[i];
      if (!_isUndefined(thisProto[prop])) {
        proto[prop] = thisProto[prop];
      }
    }

    class FullCollection extends Collection<M> {};
    FullCollection.prototype = _.extend(FullCollection.prototype, proto);
    let fullCollection = new FullCollection(models, _.extend({}, proto, options));

    for (i = 0, length = properties.length; i < length; i++) {
      prop = properties[i];
      if (this[prop] !== thisProto[prop]) {
        fullCollection[prop] = this[prop];
      }
    }

    return fullCollection;
  }

  /**
     Factory method that returns a event handler that responses to
     the `add`, `remove`, `reset`, and the `sort` events. The returned event
     handler will synchronize the current page collection and the full
     collection's models.

     @private

     @fires PageableCollection#pageable:state:change when handling an
     `add`, `remove`, or `reset` event

     @param {PageableCollection} pageCol
     @param {Collection} fullCol

     @return {function(string, Model, Collection, Object)}
     Collection event handler
  */
  _makeCollectionEventHandler (pageCol, fullCol) {

    return function collectionEventHandler (event: any) {

      let model = event.payload;
      let collection = event.emitter;
      let options = event.options || {};
      event = event.topic;
      var handlers = pageCol._handlers;
      _each(handlers, function (handler) {
        handler.unsubscribe();
      });

      var state = _clone(pageCol.state);
      var firstPage = state.firstPage;
      var currentPage = firstPage === 0 ?
        state.currentPage :
        state.currentPage - 1;
      var pageSize = state.pageSize;
      var pageStart = currentPage * pageSize, pageEnd = pageStart + pageSize;

      if (event == "add") {
        var pageIndex, fullIndex, addAt, colToAdd;
        if (collection == fullCol) {
          fullIndex = fullCol.indexOf(model);
          if (fullIndex >= pageStart && fullIndex < pageEnd) {
            colToAdd = pageCol;
            pageIndex = addAt = fullIndex - pageStart;
          }
        }
        else {
          pageIndex = pageCol.indexOf(model);
          fullIndex = pageStart + pageIndex;
          colToAdd = fullCol;
          var addAt = !_isUndefined(options.at) ?
            options.at + pageStart :
            fullIndex;
        }

        if (!options.onRemove) {
          ++state.totalRecords;
          delete options.onRemove;
        }

        pageCol.state = pageCol._checkState(state);

        if (colToAdd) {
          colToAdd.add(model, _extend({}, options, {at: addAt}));
          var modelToRemove = pageIndex >= pageSize ?
            model :
            !_isUndefined(options.at) && addAt < pageEnd && pageCol.length > pageSize ?
            pageCol.at(pageSize) :
            null;
          if (modelToRemove) {
            runOnceAtLastHandler(collection, event, function () {
              pageCol.remove(modelToRemove, {onAdd: true});
            });
          }
        }

        if (!options.silent) pageCol.event$.emit(<IEvent> {
            topic: "pageable:state:change",
            emitter: pageCol,
            payload: pageCol.state,
            options: options});
      }

      // remove the model from the other collection as well
      if (event == "remove") {
        if (!options.onAdd) {
          // decrement totalRecords and update totalPages and lastPage
          if (!--state.totalRecords) {
            state.totalRecords = null;
            state.totalPages = null;
          }
          else {
            var totalPages = state.totalPages = ceil(state.totalRecords / pageSize);
            state.lastPage = firstPage === 0 ? totalPages - 1 : totalPages || firstPage;
            if (state.currentPage > totalPages) state.currentPage = state.lastPage;
          }
          pageCol.state = pageCol._checkState(state);

          var nextModel, removedIndex = options.index;
          if (collection == pageCol) {
            if (nextModel = fullCol.at(pageEnd)) {
              runOnceAtLastHandler(pageCol, event, function () {
                pageCol.push(nextModel, {onRemove: true});
              });
            }
            else if (!pageCol.length && state.totalRecords) {
              pageCol.reset(fullCol.models.slice(pageStart - pageSize, pageEnd - pageSize),
                            _extend({}, options, {parse: false}));
            }
            fullCol.remove(model);
          }
          else if (removedIndex >= pageStart && removedIndex < pageEnd) {
            if (nextModel = fullCol.at(pageEnd - 1)) {
              runOnceAtLastHandler(pageCol, event, function() {
                pageCol.push(nextModel, {onRemove: true});
              });
            }
            pageCol.remove(model);
            if (!pageCol.length && state.totalRecords) {
              pageCol.reset(fullCol.models.slice(pageStart - pageSize, pageEnd - pageSize),
                            _extend({}, options, {parse: false}));
            }
          }
        }
        else delete options.onAdd;

        if (!options.silent) pageCol.event$.emit(<IEvent> {
            topic: "pageable:state:change",
            emitter: pageCol,
            payload: pageCol.state,
            options: options});
      }

      if (event == "reset") {
        options = collection;
        collection = model;

        // Reset that's not a result of getPage
        if (collection == pageCol && options.from == null &&
            options.to == null) {
          var head = fullCol.models.slice(0, pageStart);
          var tail = fullCol.models.slice(pageStart + pageCol.models.length);
          fullCol.reset(head.concat(pageCol.models).concat(tail), options);
        }
        else if (collection == fullCol) {
          if (!(state.totalRecords = fullCol.models.length)) {
            state.totalRecords = null;
            state.totalPages = null;
          }
          if (pageCol.mode == "client") {
            firstPage = state.lastPage = state.currentPage = state.firstPage;
            currentPage = firstPage === 0 ? state.currentPage : state.currentPage - 1;
            pageStart = currentPage * pageSize;
            pageEnd = pageStart + pageSize;
          }
          pageCol.state = pageCol._checkState(state);
          pageCol.reset(fullCol.models.slice(pageStart, pageEnd),
                        _extend({}, options, {parse: false}));
        }

        if (!options.silent) pageCol.event$.emit(<IEvent> {
            topic: "pageable:state:change",
            emitter: pageCol,
            payload: pageCol.state,
            options: options});
      }

      if (event == "sort") {
        options = collection;
        collection = model;
        if (collection === fullCol) {
          pageCol.reset(fullCol.models.slice(pageStart, pageEnd),
                        _extend({}, options, {parse: false}));
        }
      }

      _each(handlers, function (handler) {
        handler.unsubscribe();
      });
    };
  }

  /**
     Sanity check this collection's pagination states. Only perform checks
     when all the required pagination state values are defined and not null.
     If `totalPages` is undefined or null, it is set to `totalRecords` /
     `pageSize`. `lastPage` is set according to whether `firstPage` is 0 or 1
     when no error occurs.

     @private

     @throws {TypeError} If `totalRecords`, `pageSize`, `currentPage` or
     `firstPage` is not a finite integer.

     @throws {RangeError} If `pageSize`, `currentPage` or `firstPage` is out
     of bounds.

     @return {Object} Returns the `state` object if no error was found.
  */
  _checkState(state) {
    var mode = this.mode;
    var links = this.links;
    var totalRecords = state.totalRecords;
    var pageSize = state.pageSize;
    var currentPage = state.currentPage;
    var firstPage = state.firstPage;
    var totalPages = state.totalPages;

    if (totalRecords != null && pageSize != null && currentPage != null &&
        firstPage != null && (mode == "infinite" ? links : true)) {

      totalRecords = finiteInt(totalRecords, "totalRecords");
      pageSize = finiteInt(pageSize, "pageSize");
      currentPage = finiteInt(currentPage, "currentPage");
      firstPage = finiteInt(firstPage, "firstPage");

      if (pageSize < 1) {
        throw new RangeError("`pageSize` must be >= 1");
      }

      totalPages = state.totalPages = ceil(totalRecords / pageSize);

      if (firstPage < 0 || firstPage > 1) {
        throw new RangeError("`firstPage must be 0 or 1`");
      }

      state.lastPage = firstPage === 0 ? max(0, totalPages - 1) : totalPages || firstPage;

      if (mode == "infinite") {
        if (!links[currentPage + '']) {
          throw new RangeError("No link found for page " + currentPage);
        }
      }
      else if (currentPage < firstPage ||
               (totalPages > 0 &&
                (firstPage ? currentPage > totalPages : currentPage >= totalPages))) {
        throw new RangeError("`currentPage` must be firstPage <= currentPage " +
                             (firstPage ? "<" : "<=") +
                             " totalPages if " + firstPage + "-based. Got " +
                             currentPage + '.');
      }
    }

    return state;
  }

  /**
     Change the page size of this collection.

     Under most if not all circumstances, you should call this method to
     change the page size of a pageable collection because it will keep the
     pagination state sane. By default, the method will recalculate the
     current page number to one that will retain the current page's models
     when increasing the page size. When decreasing the page size, this method
     will retain the last models to the current page that will fit into the
     smaller page size.

     If `options.first` is true, changing the page size will also reset the
     current page back to the first page instead of trying to be smart.

     For server mode operations, changing the page size will trigger a
     PageableCollection#fetch and subsequently a `reset` event.

     For client mode operations, changing the page size will `reset` the
     current page by recalculating the current page boundary on the client
     side.

     If `options.fetch` is true, a fetch can be forced if the collection is in
     client mode.

     @param {number} pageSize - The new page size to set to PageableCollection#state.
     @param {Object} options - {@link PageableCollection#fetch} options.
     @param {boolean} options.first = false 0 Reset the current page number to
     the first page if `true`.
     @param {boolean} options.fetch - If `true`, force a fetch in client mode.

     @throws {TypeError} If `pageSize` is not a finite integer.
     @throws {RangeError} If `pageSize` is less than 1.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this.
  */
  setPageSize(pageSize, options: any = {first: false}) {
    pageSize = finiteInt(pageSize, "pageSize");

    var state = this.state;
    var totalPages = ceil(state.totalRecords / pageSize);
    var currentPage = totalPages ?
        max(state.firstPage, floor(totalPages * state.currentPage / state.totalPages)) :
      state.firstPage;

    state = this.state = this._checkState(_extend({}, state, {
      pageSize: pageSize,
      currentPage: options.first ? state.firstPage : currentPage,
      totalPages: totalPages
    }));

    return this.getPage(state.currentPage, _omit(options, ["first"]));
  }

  /**
     Switching between client, server and infinite mode.

     If switching from client to server mode, the #fullCollection is emptied
     first and then deleted and a fetch is immediately issued for the current
     page from the server. Pass `false` to `options.fetch` to skip fetching.

     If switching to infinite mode, and if `options.models` is given for an
     array of models,PageableCollection#links will be populated with a URL per
     page, using the default URL for this collection.

     If switching from server to client mode, all of the pages are immediately
     refetched. If you have too many pages, you can pass `false` to
     `options.fetch` to skip fetching.

     If switching to any mode from infinite mode, thePageableCollection#links
     will be deleted.

     @fires PageableCollection#pageable:state:change

     @param {"server"|"client"|"infinite"} mode - The mode to switch to.

     @param {Object} options

     @param {boolean} options.fetch = true - If `false`, no fetching is done.

     @param {boolean} options.resetState = true - If 'false', the state is not
     reset, but checked for sanity instead.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this if `options.fetch` is `false`.
  */
  switchMode (mode, options: any = {fetch: true, resetState: true}) {

    if (!_contains(["server", "client", "infinite"], mode)) {
      throw new TypeError('`mode` must be one of "server", "client" or "infinite"');
    }

    var state = this.state = options.resetState ?
      _clone(this._initState) :
      this._checkState(_extend({}, this.state));

    this.mode = mode;

    var self = this;
    var fullCollection = this.fullCollection;
    var handlers = this._handlers = this._handlers || [];
    if (mode != "server" && !fullCollection) {
      fullCollection = this._makeFullCollection(options.models || [], options);
      fullCollection.pageableCollection = this;
      this.fullCollection = fullCollection;
      var handler = this._makeCollectionEventHandler(this, fullCollection);
      handlers.push(
        this.event$.filter(e => _contains(["add", "remove", "reset", "sort"], e.topic)).subscribe(handler));
      handlers.push(
        fullCollection.event$.filter(e => _contains(["add", "remove", "reset", "sort"], e.topic)).subscribe(handler));
      fullCollection.comparator = this._fullComparator;
    }
    else if (mode == "server" && fullCollection) {
      _each(handlers, function (handler) {
        handler.unsubscribe();
      });
      delete this._handlers;
      this._fullComparator = fullCollection.comparator;
      delete this.fullCollection;
    }

    if (mode == "infinite") {
      var links = this.links = {};
      var firstPage = state.firstPage;
      var totalPages = ceil(state.totalRecords / state.pageSize);
      var lastPage = firstPage === 0 ? max(0, totalPages - 1) : totalPages || firstPage;
      for (var i = state.firstPage; i <= lastPage; i++) {
        links[i] = this.url;
      }
    }
    else if (this.links) delete this.links;

    if (!options.silent) this.event$.emit(<IEvent> {
        topic: "pageable:state:change",
        emitter: this,
        payload: state,
        options: options});

    return options.fetch ?
      this.fetch(_omit(options, "fetch", "resetState")) :
      this;
  }

  /**
     @return {boolean} `true` if this collection can page backward, `false`
     otherwise.
  */
  hasPreviousPage () {
    var state = this.state;
    var currentPage = state.currentPage;
    if (this.mode != "infinite") return currentPage > state.firstPage;
    return !!this.links[currentPage - 1];
  }

  /**
     @return {boolean} `true` if this collection can page forward, `false`
     otherwise.
  */
  hasNextPage () {
    var state = this.state;
    var currentPage = this.state.currentPage;
    if (this.mode != "infinite") return currentPage < state.lastPage;
    return !!this.links[currentPage + 1];
  }

  /**
     Fetch the first page in server mode, or reset the current page of this
     collection to the first page in client or infinite mode.

     @param {Object} options {@linkPageableCollection#getPage} options.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this.
  */
  getFirstPage (options: any = {}) {
    return this.getPage("first", options);
  }

  /**
     Fetch the previous page in server mode, or reset the current page of this
     collection to the previous page in client or infinite mode.

     @param {Object} options {@linkPageableCollection#getPage} options.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this.
  */
  getPreviousPage (options: any = {}) {
    return this.getPage("prev", options);
  }

  /**
     Fetch the next page in server mode, or reset the current page of this
     collection to the next page in client mode.

     @param {Object} options {@linkPageableCollection#getPage} options.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this.
  */
  getNextPage (options: any = {}) {
    return this.getPage("next", options);
  }

  /**
     Fetch the last page in server mode, or reset the current page of this
     collection to the last page in client mode.

     @param {Object} options {@linkPageableCollection#getPage} options.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this.
  */
  getLastPage (options: any = {}) {
    return this.getPage("last", options);
  }

  /**
     Given a page index, set PageableCollection#state.currentPage to that
     index. If this collection is in server mode, fetch the page using the
     updated state, otherwise, reset the current page of this collection to
     the page specified by `index` in client mode. If `options.fetch` is true,
     a fetch can be forced in client mode before resetting the current
     page. Under infinite mode, if the index is less than the current page, a
     reset is done as in client mode. If the index is greater than the current
     page number, a fetch is made with the results **appended**
     toPageableCollection#fullCollection.  The current page will then be reset
     after fetching.

     @fires PageableCollection#pageable:state:change

     @param {number|string} index - The page index to go to, or the page name to
     look up fromPageableCollection#links in infinite mode.
     @param {Object} options - {@linkPageableCollection#fetch} options or
     [reset](http://backbonejs.org/#Collection-reset) options for client mode
     when `options.fetch` is `false`.
     @param {boolean} options.fetch = false - If true, force a
     {@linkPageableCollection#fetch} in client mode.

     @throws {TypeError} If `index` is not a finite integer under server or
     client mode, or does not yield a URL fromPageableCollection#links under
     infinite mode.

     @throws {RangeError} If `index` is out of bounds.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this.
  */
  getPage (index, options: any = {fetch: false}) {

    var mode = this.mode, fullCollection = this.fullCollection;

    var state = this.state,
    firstPage = state.firstPage,
    currentPage = state.currentPage,
    lastPage = state.lastPage,
    pageSize = state.pageSize;

    var pageNum = index;
    switch (index) {
      case "first": pageNum = firstPage; break;
      case "prev": pageNum = currentPage - 1; break;
      case "next": pageNum = currentPage + 1; break;
      case "last": pageNum = lastPage; break;
      default: pageNum = finiteInt(index, "index");
    }

    this.state = this._checkState(_extend({}, state, {currentPage: pageNum}));
    if (!options.silent) this.event$.emit(<IEvent> {
        topic: "pageable:state:change",
        emitter: this,
        payload: this.state,
        options: options});

    options.from = currentPage, options.to = pageNum;

    var pageStart = (firstPage === 0 ? pageNum : pageNum - 1) * pageSize;
    var pageModels = fullCollection && fullCollection.length ?
      fullCollection.models.slice(pageStart, pageStart + pageSize) :
      [];
    if ((mode == "client" || (mode == "infinite" && !_isEmpty(pageModels))) &&
        !options.fetch) {
      this.reset(pageModels, _omit(options, "fetch"));
      return this;
    }

    if (mode == "infinite") options.url = this.links[pageNum];

    return this.fetch(_omit(options, "fetch"));
  }

  /**
     Fetch the page for the provided item offset in server mode, or reset the
     current page of this collection to the page for the provided item offset
     in client mode.

     @param {Object} options {@linkPageableCollection#getPage} options.

     @chainable
     @return {XMLHttpRequest|PageableCollection} The XMLHttpRequest
     from fetch or this.
  */
  getPageByOffset (offset, options: any = {}) {
    if (offset < 0) {
      throw new RangeError("`offset must be > 0`");
    }
    offset = finiteInt(offset);

    var page = floor(offset / this.state.pageSize);
    if (this.state.firstPage !== 0) page++;
    if (page > this.state.lastPage) page = this.state.lastPage;
    return this.getPage(page, options);
  }

  /**
     Overidden to make `getPage` compatible with Zepto.

     @param {string} method
     @param {Model|Collection} model
     @param {Object} options

     @return {XMLHttpRequest}
  */
  sync(method: string, options: any = {}) {
    return super.sync(method, options);
  }

  /**
     Parse pagination links from the server response.

     Given a response body and a XMLHttpRequest object, extract pagination
     links from them for infinite paging.

     This default implementation parses the RFC 5988 `Link` header and extract
     4 links from it - `first`, `prev`, `next` and `last`. Any subclasses overriding this
     method __must__ return an object hash having only the keys
     above. However, simply returning a `next` link or an empty hash if there
     are no more links should be enough for most implementations.

     @param {*} resp The response object.
     @param {Object} options
     @return {Object}
  */
  parseLinks (resp, options: any = {}) {
    var links = {};
    var linkHeader = resp.get("Link");
    if (linkHeader) {
      var relations = ["first", "prev", "next", "last"];
      _each(linkHeader.split(","), function (linkValue) {
        var linkParts = linkValue.split(";");
        var url = linkParts[0].replace(URL_TRIM_RE, '');
        var params = linkParts.slice(1);
        _each(params, function (param) {
          var paramParts = param.split("=");
          var key = paramParts[0].replace(PARAM_TRIM_RE, '');
          var value = paramParts[1].replace(PARAM_TRIM_RE, '');
          if (key == "rel" && _contains(relations, value)) links[value] = url;
        });
      });
    }

    return links;
  }

  /**
     Parse server response data.

     This default implementation assumes the response data is in one of two
     structures:

         [
           {}, // Your new pagination state
           [{}, ...] // An array of JSON objects
         ]

     Or,

         [{}] // An array of JSON objects

     The first structure is the preferred form because the pagination states
     may have been updated on the server side, sending them down again allows
     this collection to update its states. If the response has a pagination
     state object, it is checked for errors.

     The second structure is the
     [Collection#parse](http://backbonejs.org/#Collection-parse)
     default.

     **Note:** this method has been further simplified since 1.1.7. While
     existingPageableCollection#parse implementations will continue to work,
     new code is encouraged to overridePageableCollection#parseState
     andPageableCollection#parseRecords instead.

     @param {Object} resp The deserialized response data from the server.
     @param {Object} the options for the ajax request

     @return {Array.<Object>} An array of model objects
  */
  parse (resp, options: any = {}) {
    var currentPage = this.state.currentPage;
    var links = this.links;
    var newLinks = this.parseLinks(resp, options);
    if (newLinks.first) links[this.state.firstPage] = newLinks.first;
    if (newLinks.prev) links[currentPage - 1] = newLinks.prev;
    if (newLinks.next) links[currentPage + 1] = newLinks.next;
    if (newLinks.last) links[this.state.lastPage] = newLinks.last;

    var newState = this.parseState(resp, _clone(this.queryParams), _clone(this.state), options);
    if (newState) this.state = this._checkState(_extend({}, this.state, newState));

    return this.parseRecords(resp, options);
  }

  /**
     Parse server response for server pagination state updates. Not applicable
     under infinite mode.

     This default implementation first checks whether the response has any
     state object as documented inPageableCollection#parse. If it exists, a
     state object is returned by mapping the server state keys to this
     pageable collection instance's query parameter keys using `queryParams`.

     It is __NOT__ neccessary to return a full state object complete with all
     the mappings defined inPageableCollection#queryParams. Any state object
     resulted is merged with a copy of the current pageable collection state
     and checked for sanity before actually updating. Most of the time, simply
     providing a new `totalRecords` value is enough to trigger a full
     pagination state recalculation.

         parseState: function (resp, queryParams, state, options) {
           return {totalRecords: resp.total_entries};
         }

     If you want to use header fields use:

         parseState: function (resp, queryParams, state, options) {
             return {totalRecords: options.xhr.getResponseHeader("X-total")};
         }

     This method __MUST__ return a new state object instead of directly
     modifying the PageableCollection#state object. The behavior of directly
     modifying PageableCollection#state is undefined.

     @param {Object} resp - The deserialized response data from the server.
     @param {Object} queryParams - A copy of PageableCollection#queryParams.
     @param {Object} state - A copy of PageableCollection#state.
     @param {Object} options - The options passed through from
     `parse`. (backbone >= 0.9.10 only)

     @return {Object} A new (partial) state object.
   */
  parseState (resp, queryParams, state, options: any = {}) {
    if (resp && resp.length === 2 && _isObject(resp[0]) && _isArray(resp[1])) {

      var newState = _clone(state);
      var serverState = resp[0];

      _each(_pairs(_omit(queryParams, "directions")), function (kvp) {
        var k = kvp[0], v = kvp[1];
        var serverVal = serverState[v];
        if (!_isUndefined(serverVal) && !_.isNull(serverVal)) newState[k] = serverState[v];
      });

      if (serverState.order) {
        newState.order = _invert(queryParams.directions)[serverState.order] * 1;
      }

      return newState;
    }
  }

  /**
     Parse server response for an array of model objects.

     This default implementation first checks whether the response has any
     state object as documented inPageableCollection#parse. If it exists, the
     array of model objects is assumed to be the second element, otherwise the
     entire response is returned directly.

     @param {Object} resp - The deserialized response data from the server.
     @param {Object} options - The options passed through from the
     `parse`. (backbone >= 0.9.10 only)

     @return {Array.<Object>} An array of model objects
   */
  parseRecords (resp, options: any = {}) {
    if (resp && resp.length === 2 && _isObject(resp[0]) && _isArray(resp[1])) {
      return resp[1];
    }

    return resp;
  }

  /**
     Fetch a page from the server in server mode, or all the pages in client
     mode. Under infinite mode, the current page is refetched by default and
     then reset.

     The query string is constructed by translating the current pagination
     state to your server API query parameter
     usingPageableCollection#queryParams. The current page will reset after
     fetch.

     @param {Object} options - Accepts all
     [Backbone.Collection#fetch](http://backbonejs.org/#Collection-fetch)
     options.

     @return {XMLHttpRequest}
  */
  fetch(options: any = {}) {
    var state = this._checkState(this.state);

    var mode = this.mode;

    if (mode == "infinite" && !options.url) {
      options.url = this.links[state.currentPage];
    }

    var query = options.query || (options.query = {});

    // map params except directions
    var queryParams = this.mode == "client" ?
      _pick(this.queryParams, "sortKey", "order") :
      _omit(this.queryParams, "directions");

    var thisCopy = _.clone(this);
    _.each(queryParams, function (v, k) {
      v = _isFunction(v) ? v.call(thisCopy) : v;
      if (state[k] != null && v != null && _.isUndefined(query[v])) {
        query[v] = state[k];
      }
    }, this);

    // fix up sorting parameters
    var i;
    if (state.sortKey && state.order) {
      var o = _isFunction(queryParams.order) ?
        queryParams.order.call(thisCopy) :
        queryParams.order;
        if (!_isArray(state.order)) {
            query[o] = this.queryParams.directions[state.order + ""];
        }
        else {
            query[o] = [];
            for (i = 0; i < state.order.length; i += 1) {
                query[o].push(this.queryParams.directions[state.order[i]]);
            }
        }
    }
    else if (!state.sortKey) delete query[queryParams.order];

    let obs$ = super.fetch(
      _extend({}, options, {silent: mode != "server"}) // on client and infinite silent the first reset from backbone
    );

    if (mode != "server") {
      obs$.subscribe(resp => {
        var models = this.models;
        if (mode == "client") this.fullCollection.reset(models, options);
        else {
          this.fullCollection.add(models, _extend({at: this.fullCollection.length},
                                      _extend(options, {parse: false})));
          this.event$.emit(<IEvent> {
              topic: "reset",
              emitter: this,
              options: options});
        }
      });
    }

    return obs$;
  }

  /**
     Convenient method for making a `comparator` sorted by a model attribute
     identified by `sortKey` and ordered by `order`.

     Like a Backbone.Collection, a PageableCollection will maintain the
     __current page__ in sorted order on the client side if a `comparator` is
     attached to it. If the collection is in client mode, you can attach a
     comparator toPageableCollection#fullCollection to have all the pages
     reflect the global sorting order by specifying an option `full` to
     `true`. You __must__ call `sort` manually
     orPageableCollection#fullCollection.sort after calling this method to
     force a resort.

     While you can use this method to sort the current page in server mode,
     the sorting order may not reflect the global sorting order due to the
     additions or removals of the records on the server since the last
     fetch. If you want the most updated page in a global sorting order, it is
     recommended that you set PageableCollection#state.sortKey and optionally
     PageableCollection#state.order, and then callPageableCollection#fetch.

     @protected

     @param {string} sortKey = this.state.sortKey - See `state.sortKey`.
     @param {number} order = this.state.order - See `state.order`.
     @param {(function(Backbone.Model, string): Object) | string} sortValue -
     See PageableCollection#setSorting.

     See [Backbone.Collection.comparator](http://backbonejs.org/#Collection-comparator).
  */
  _makeComparator (sortKey, order, sortValue) {
    var state = this.state;

    sortKey = sortKey || state.sortKey;
    order = order || state.order;

    if (!sortKey || !order) return;

    if (!sortValue) sortValue = function (model, attr) {
      return model.get(attr);
    };

    return function (left, right) {
      var l = sortValue(left, sortKey), r = sortValue(right, sortKey), t;
      if (order === 1) t = l, l = r, r = t;
      if (l === r) return 0;
      else if (l < r) return -1;
      return 1;
    };
  }

  /**
     Adjusts the sorting for this pageable collection.

     Given a `sortKey` and an `order`, sets `state.sortKey` and
     `state.order`. A comparator can be applied on the client side to sort in
     the order defined if `options.side` is `"client"`. By default the
     comparator is applied to thePageableCollection#fullCollection. Set
     `options.full` to `false` to apply a comparator to the current page under
     any mode. Setting `sortKey` to `null` removes the comparator from both
     the current page and the full collection.

     If a `sortValue` function is given, it will be passed the `(model,
     sortKey)` arguments and is used to extract a value from the model during
     comparison sorts. If `sortValue` is not given, `model.get(sortKey)` is
     used for sorting.

     @chainable

     @param {string} sortKey - See `state.sortKey`.
     @param {number} order=this.state.order - See `state.order`.
     @param {Object} options
     @param {string} options.side - By default, `"client"` if `mode` is
     `"client"`, `"server"` otherwise.
     @param {boolean} options.full = true
     @param {(function(Backbone.Model, string): Object) | string} options.sortValue
  */
  setSorting(sortKey, order, options: any = {}) {

    var state = this.state;

    state.sortKey = sortKey;
    state.order = order = order || state.order;

    var fullCollection = this.fullCollection;

    var delComp = false, delFullComp = false;

    if (!sortKey) delComp = delFullComp = true;

    var mode = this.mode;
    options = _extend({side: mode == "client" ? mode : "server", full: true},
                      options);

    var comparator = this._makeComparator(sortKey, order, options.sortValue);

    var full = options.full, side = options.side;

    if (side == "client") {
      if (full) {
        if (fullCollection) fullCollection.comparator = comparator;
        delComp = true;
      }
      else {
        this.comparator = comparator;
        delFullComp = true;
      }
    }
    else if (side == "server" && !full) {
      this.comparator = comparator;
    }

    if (delComp) this.comparator = null;
    if (delFullComp && fullCollection) fullCollection.comparator = null;

    return this;
  }
}
