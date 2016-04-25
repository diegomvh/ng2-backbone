import * as _ from 'underscore';
import {Injectable, Output, EventEmitter} from 'angular2/core';
import {Http, Response} from 'angular2/http';
import {Headers, URLSearchParams, Request, RequestMethod, RequestOptions} from 'angular2/http';
import {Observable} from 'rxjs/Rx';

import {Model} from './model'
import {Collection} from './collection'
import {ISynchronizable, IEvent} from './interface'

declare var __CSRF_TOKEN: string;

function buildParams(prefix, obj, append) {
  if (_.isArray(obj)) {
    // Serialize array item.
    _.each(obj, function (value, index) {
      if (/\[\]$/.test(prefix)) {
        append(prefix, value);
      }
      else {
        buildParams(
          prefix + "[" + (typeof value === "object" || _.isArray(value) ?
            index : "") + "]", value, append
        );
      }
    });
  }
  else if (obj != null && typeof obj === "object") {
    // Serialize object item.
    _.each(obj, function (value, key) {
      buildParams(prefix + "[" + key + "]", value, append);
    });
  }
  else {
    // Serialize scalar item.
    append(prefix, obj);
  }
}

export class Service<M, C> {
  protected url: string;
  protected model: INewable<M>;
  protected collection: INewable<C>;
  // Turn on `emulateHTTP` to support legacy HTTP servers. Setting this option
  // will fake `"PATCH"`, `"PUT"` and `"DELETE"` requests via the `_method` parameter and
  // set a `X-Http-Method-Override` header.
  protected emulateHTTP: boolean = false;

  // Turn on `emulateJSON` to support legacy servers that can't deal with direct
  // `application/json` requests ... this will encode the body as
  // `application/x-www-form-urlencoded` instead and will send the model in a
  // form param named `model`.
  protected emulateJSON: boolean = false;
  protected methodMap = {
    'create': RequestMethod.Post,
    'update': RequestMethod.Put,
    'patch': RequestMethod.Patch,
    'delete': RequestMethod.Delete,
    'options': RequestMethod.Options,
    'head': RequestMethod.Head,
    'read': RequestMethod.Get
  }

  constructor (protected _http: Http) {
  }

  _search (extra = {}) {
    var search = new URLSearchParams();
    var append = (key, value) => {
      value = _.isFunction(value) ? value() : value;
      search.append(key, value);
    };
    for (var prefix in extra)
      buildParams(prefix, extra[prefix], append);
    return search;
  }

  _headers (extra = {}) : Headers {
    let headers = new Headers({
      'X-CSRFToken': __CSRF_TOKEN,
      'Accept': 'application/json'
    });
    _.each(extra, (value, key) => {
      value = _.isArray(value) ? value : [value];
      _.each(value, v => headers.append(key, v));
    });
    return headers;
  }

  sync<E extends ISynchronizable>(method: string, model: E, options: any = {}) : Observable<E> {
    let type = this.methodMap[method];

    // Default options, unless specified.
    _.defaults(options, {
      emulateHTTP: this.emulateHTTP,
      emulateJSON: this.emulateJSON
    });

    var params = {
      url: null,
      method: type,
      headers: this._headers(options.headers),
      search: this._search(options.query),
      body: null
    };

    // Ensure that we have a URL.
    if (!options.url) {
      params.url = _.result(model, 'url') || model.event$.error("url");
    }

    // Ensure that we have the appropriate request data.
    if (model && (method === 'create' || method === 'update' || method === 'patch')) {
      params.headers.set('Content-Type', 'application/json');
      params.body = JSON.stringify(options.attrs || model.toJSON(options));
    }

    // For older servers, emulate JSON by encoding the request into an HTML-form.
    if (options.emulateJSON) {
      params.headers.set('Content-Type', 'application/x-www-form-urlencoded');
      params.body = params.body ? {model: params.body} : {};
    }

    // For older servers, emulate HTTP by mimicking the HTTP method with `_method`
    // And an `X-HTTP-Method-Override` header.
    if (options.emulateHTTP && (type ===  RequestMethod.Put || type === RequestMethod.Delete || type === RequestMethod.Patch)) {
      type = RequestMethod.Post;
      if (options.emulateJSON) params.body._method = 'POST';
      params.headers.set('X-HTTP-Method-Override', 'POST');
    }

    // Don't process body on a non-GET request.
    params.body = (type !== RequestMethod.Get && !options.emulateJSON) ?
      params.body : JSON.stringify(params.body);

    // Make the request, allowing the user to override any request options.
    params = _.extend(params, _.omit(options, "headers"));
    let req = new Request(new RequestOptions(params));

    let obs$ = options.obs$ = this._http.request(req)
      .catch(error => this._onError(error))
      .share();
    model.event$.emit(<IEvent> {
      topic: 'request',
      emitter: model,
      payload: obs$,
      options: params});
    return obs$;
  }

  createCollection (models?: any, options?) : C {
    return new this.collection(
      models, _.extend({service: this}, options));
  }

  createModel (attrs?: any, options?) : M {
    return new this.model(
      attrs, _.extend({service: this}, options));
  }

  modelId (attrs: any) {
    return attrs[this.model.prototype.idAttribute || 'id'];
  }

  paramsToQueryString(params) {
    var s = [], encode = encodeURIComponent, append = (key, value) => {
      value = _.isFunction(value) ? value() : value;
      s[s.length] = encode(key) + "=" + encode(value);
    };
    for (var prefix in params)
      buildParams(prefix, params[prefix], append);
    return s.join( "&" ).replace( /%20/g, "+" );
  }

  queryStringToParams(qs) {
    var kvp, k, v, ls, params = {}, decode = decodeURIComponent;
    var kvps = qs.split('&');
    for (var i = 0, l = kvps.length; i < l; i++) {
      var param = kvps[i];
      kvp = param.split('='), k = kvp[0], v = kvp[1];
      if (v == null) v = true;
      k = decode(k), v = decode(v), ls = params[k];
      if (_.isArray(ls)) ls.push(v);
      else if (ls) params[k] = [ls, v];
      else params[k] = v;
    }
    return params;
  }

  protected _onError (error: any) {
    return Observable.throw(error.json().error || 'Server error');
  }
}
