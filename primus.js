'use strict';

/**
 * Primus in a real-time library agnostic framework for establishing real-time
 * connections with servers.
 *
 * @constructor
 * @param {String} url The url of your server.
 * @param {Object} options The configuration.
 * @api private
 */
function Primus(url, options) {
  if (!(this instanceof Primus)) return new Primus(url);
  options = options || {};

  this.buffer = [];                       // Stores premature send data.
  this._events = {};                      // Stores the events.
  this.writable = true;                   // Silly stream compatibility.
  this.readable = true;                   // Silly stream compatibility.
  this.url = this.parse(url);             // Parse the url to a readable format.
  this.backoff = options.reconnect || {}; // Stores the backoff configuration.
  this.readyState = Primus.CLOSED;        // The readyState of the connection.

  if (Stream) Stream.call(this);          // Initialize a stream interface.

  this.initialise().open();
}

Primus.OPENING = 0;   // We're opening the connection.
Primus.CLOSED  = 1;   // No active connection.
Primus.OPEN    = 2;   // The connection is open.

//
// It's possible that we're running in Node.js or in a Node.js compatible
// environment such as browserify. In these cases we want to use some build in
// libraries to minimize our dependence on the DOM.
//
var Stream, parse;

try {
  parse = require('url').parse;
  Stream = require('stream');

  Primus.prototype = new Stream();
} catch (e) {
  parse = function parse(url) {
    var a = document.createElement('a');
    a.href = url;

    return a;
  };
}

/**
 * Initialise the Primus and setup all parsers and internal listeners.
 *
 * @api private
 */
Primus.prototype.initialise = function initalise() {
  var primus = this;

  this.on('outgoing::open', function opening() {
    primus.readyState = Primus.OPENING;
  });

  this.on('incoming::open', function opened() {
    primus.readyState = Primus.OPEN;
    primus.emit('open');

    if (primus.buffer.length) {
      for (var i = 0, length = primus.buffer.length; i < length; i++) {
        primus.write(primus.buffer[i]);
      }

      primus.buffer.length = 0;
    }
  });

  this.on('incoming::data', function message(raw) {
    primus.decoder(raw, function decoding(err, packet) {
      //
      // Do a "save" emit('error') when we fail to parse a message. We don't
      // want to throw here as listening to errors should be optional.
      //
      if (err) return primus.listeners('error').length && primus.emit('error', err);
      if ('primus::server::close' === packet) return primus.emit('incoming::end', packet);
      primus.emit('data', packet, raw);
    });
  });

  this.on('incoming::end', function end(intentional) {
    if (primus.readyState === Primus.CLOSED) return;
    primus.readyState = Primus.CLOSED;

    //
    // Some transformers emit garbage when they close the connection. Like the
    // reason why it closed etc, we should explicitly check if WE send an
    // intentional message.
    //
    if ('primus::server::close' === intentional) return primus.emit('end');

    this.reconnect(function reconnect(fail, backoff) {
      primus.backoff = backoff; // Save the opts again of this backoff.
      if (fail) return primus.emit('end');

      //
      // Try to re-open the connection again.
      //
      primus.emit('reconnect', backoff);
      primus.emit('outgoing::reconnect');
    }, primus.backoff);
  });

  //
  // Setup the real-time client.
  //
  this.client();

  return this;
};

/**
 * Establish a connection with the server.
 *
 * @api private
 */
Primus.prototype.open = function open() {
  this.emit('outgoing::open');

  return this;
};

/**
 * Send a new message.
 *
 * @param {Mixed} data The data that needs to be written.
 * @returns {Boolean} Always returns true.
 * @api public
 */
Primus.prototype.write = function write(data) {
  var primus = this;

  if (this.readyState === Primus.OPEN) {
    this.encoder(data, function encoded(err, packet) {
      //
      // Do a "save" emit('error') when we fail to parse a message. We don't
      // want to throw here as listening to errors should be optional.
      //
      if (err) return primus.listeners('error').length && primus.emit('error', err);
      primus.emit('outgoing::data', packet);
    });
  } else {
    primus.buffer.push(data);
  }

  return true;
};

/**
 * Close the connection.
 *
 * @param {Mixed} data last packet of data.
 * @api public
 */
Primus.prototype.end = function end(data) {
  if (this.readyState === Primus.CLOSED) return this;
  if (data) this.write(data);

  this.writable = false;
  this.readyState = Primus.CLOSED;

  this.emit('outgoing::end');
  this.emit('end');

  return this;
};

/**
 * Exponential backoff algorithm for retry operations. It uses an randomized
 * retry so we don't DDOS our server when it goes down under pressure.
 *
 * @param {Function} callback Callback to be called after the timeout.
 * @param {Object} opts Options for configuring the timeout.
 * @api private
 */
Primus.prototype.reconnect = function reconnect(callback, opts) {
  opts = opts || {};

  opts.maxDelay = opts.maxDelay || Infinity;  // Maximum delay.
  opts.minDelay = opts.minDelay || 500;       // Minimum delay.
  opts.retries = opts.retries || 10;          // Amount of allowed retries.
  opts.attempt = (+opts.attempt || 0) + 1;    // Current attempt.
  opts.factor = opts.factor || 2;             // Backoff factor.

  // Bailout if we are about to make to much attempts. Please note that we use
  // `>` because we already incremented the value above.
  if (opts.attempt > opts.retries || opts.backoff) {
    return callback(new Error('Unable to retry'), opts);
  }

  // Prevent duplicate backoff attempts.
  opts.backoff = true;

  // Calculate the timeout, but make it randomly so we don't retry connections
  // at the same interval and defeat the purpose. This exponential backoff is
  // based on the work of:
  //
  // http://dthain.blogspot.nl/2009/02/exponential-backoff-in-distributed.html
  opts.timeout = opts.attempt !== 1
    ? Math.min(Math.round(
        (Math.random() * 1) * opts.minDelay * Math.pow(opts.factor, opts.attempt)
      ), opts.maxDelay)
    : opts.minDelay;

  setTimeout(function delay() {
    opts.backoff = false;
    callback(undefined, opts);
  }, opts.timeout);

  return this;
};

/**
 * Parse the connection string.
 *
 * @param {String} url Connection url.
 * @returns {Object} Parsed connection.
 * @api public
 */
Primus.prototype.parse = parse;

/**
 * Generates a connection uri.
 *
 * @param {String} protocol The protocol that should used to crate the uri.
 * @param {Boolean} querystring Do we need to include a querystring.
 * @returns {String} The url.
 * @api private
 */
Primus.prototype.uri = function uri(protocol, querystring) {
  var server = [];

  server.push(this.url.protocol === 'https:' ? protocol +'s:' : protocol +':', '');
  server.push(this.url.host, this.pathname.slice(1));

  //
  // Optionally add a search query.
  //
  if (this.url.search && querystring) server.push(this.url.search);
  return server.join('/');
};

/**
 * Return a list of assigned event listeners.
 *
 * @param {String} event The events that should be listed.
 * @returns {Array}
 * @api public
 */
Primus.prototype.listeners = function listeners(event) {
  return (this._events[event] || []).slice(0);
};

/**
 * Emit an event to all registered event listeners.
 *
 * @param {String} event The name of the event.
 * @returns {Boolean} Indication if we've emitted an event.
 * @api public
 */
Primus.prototype.emit = function emit(event) {
  if (!(event in this._events)) return false;

  var args = Array.prototype.slice.call(arguments, 1)
    , length = this._events[event].length
    , i = 0;

  for (; i < length; i++) {
    this._events[event][i].apply(this, args);
  }

  return true;
};

/**
 * Register a new EventListener for the given event.
 *
 * @param {String} event Name of the event.
 * @param {Functon} fn Callback function.
 * @api public
 */
Primus.prototype.on = function on(event, fn) {
  if (!(event in this._events)) this._events[event] = [];
  this._events[event].push(fn);

  return this;
};

/**
 * Remove event listeners.
 *
 * @param {String} event The event we want to remove.
 * @param {Function} fn The listener that we need to find.
 * @api public
 */
Primus.prototype.removeListener = function removeListener(event, fn) {
  if (!this._events || !(event in this._events)) return this;

  var listeners = this._events[event]
    , events = [];

  for (var i = 0, length = listeners.length; i < length; i++) {
    if (!fn || listeners[i] === fn) continue;

    events.push(listeners[i]);
  }

  //
  // Reset the array, or remove it completely if we have no more listeners.
  //
  if (events.length) this._events[event] = events;
  else delete this._events[event];

  return this;
};

/**
 * Simple emit wrapper that returns a function that emits an event once it's
 * called. This makes it easier for transports to emit specific events. The
 * scope of this function is limited as it will only emit one single argument.
 *
 * @param {String} event Name of the event that we should emit.
 * @param {Function} parser Argument parser.
 * @api public
 */
Primus.prototype.emits = function emits(event, parser) {
  var primus = this;

  return function emit(arg) {
    var data = parser ? parser.apply(primus, arguments) : arg;

    //
    // Timeout is required to prevent crashes on WebSockets connections on
    // mobile devices. We need to handle these edge cases in our own library
    // as we cannot be certain that all frameworks fix these issues.
    //
    setTimeout(function timeout() {
      primus.emit('incoming::'+ event, data);
    }, 0);
  };
};

/**
 * Syntax sugar, adopt a Socket.IO like API.
 *
 * @param {String} url The url we want to connect to.
 * @param {Object} options Connection options.
 * @returns {Primus}
 * @api public
 */
Primus.connect = function connect(url, options) {
  return new Primus(url, options);
};

//
// These libraries are automatically are automatically inserted at the
// serverside using the Primus#library method.
//
Primus.prototype.pathname = null; // @import {primus::pathname};
Primus.prototype.client = null; // @import {primus::transport};
Primus.prototype.encoder = null; // @import {primus::encoder};
Primus.prototype.decoder = null; // @import {primus::decoder};
Primus.prototype.version = null; // @import {primus::version};
