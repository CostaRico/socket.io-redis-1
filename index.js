'use strict';
/**
 * Module dependencies.
 */

var uid2 = require('uid2');
var redis = require('redis').createClient;
var Adapter = require('socket.io-adapter');
var Emitter = require('events').EventEmitter;
var debug = require('debug')('socket.io-redis');
var Promise = require('bluebird');

/**
 * Module exports.
 */

module.exports = adapter;

/**
 * Returns a redis Adapter class.
 *
 * @param {String} optional, redis uri
 * @return {RedisAdapter} adapter
 * @api public
 */

function adapter(uri, opts){
  opts = opts || {};

  // handle options only
  if ('object' == typeof uri) {
    opts = uri;
    uri = null;
  }

  // opts
  var pub = opts.pubClient;
  var sub = opts.subClient;
  var prefix = opts.key || 'socket.io';
  var subEvent = opts.subEvent || 'message';

  // init clients if needed
  function createClient(redis_opts) {
    if (uri) {
      // handle uri string
      return redis(uri, redis_opts);
    } else {
      return redis(opts.port, opts.host, redis_opts);
    }
  }
  
  if (!pub) pub = createClient();
  if (!sub) sub = createClient({ return_buffers: false });

  // this server's key
  var uid = opts.uid2 ? opts.uid2 : uid2(6);

  /**
   * Adapter constructor.
   *
   * @param {String} namespace name
   * @api public
   */

  function Redis(nsp){
    Adapter.call(this, nsp);

    this.uid = uid;
    this.prefix = prefix;
    this.channel = prefix + '#' + nsp.name + '#';
    this.channelMatches = function (messageChannel, subscribedChannel) {
      return messageChannel.startsWith(subscribedChannel);
    };
    this.pubClient = pub;
    this.subClient = sub;

    sub.subscribe(this.channel, (err) => {
      if (err) this.emit('error', err);
    });
    sub.on(subEvent, this.onmessage.bind(this));
  }

  /**
   * Inherits from `Adapter`.
   */

  Redis.prototype.__proto__ = Adapter.prototype;

  /**
   * Called with a subscription message
   *
   * @api private
   */

  Redis.prototype.onmessage = function(channel, msg){
    if (!this.channelMatches(channel.toString(), this.channel)) {
      return debug('ignore different channel');
    }
    var args = JSON.parse(msg);
    var packet = args[1];

    if (packet && packet.nsp === undefined) {
      packet.nsp = '/';
    }

    if (!packet || packet.nsp != this.nsp.name) {
      return debug('ignore different namespace');
    }

    args.push(true);

    this.broadcast.apply(this, args);
  };

  /**
   * Broadcasts a packet.
   *
   * @param {Object} packet to emit
   * @param {Object} options
   * @param {Boolean} whether the packet came from another node
   * @api public
   */

  Redis.prototype.broadcast = function(packet, opts, remote){
    var newPacket = Object.assign({}, packet);
    Adapter.prototype.broadcast.call(this, packet, opts);
    newPacket.nsp = packet.nsp;
    newPacket.type = packet.type;
    if (!remote) {
      var chn = this.prefix + '#' + newPacket.nsp + '#';
      var msg = JSON.stringify([uid, newPacket, opts]);
      if (opts.rooms) {
        opts.rooms.map( (room) => {
          var chnRoom = chn + room + '#';
          pub.publish(chnRoom, msg);
        });
      } else {
        pub.publish(chn, msg);
      }
    }
  };

  /**
   * Subscribe client to room messages.
   *
   * @param {String} client id
   * @param {String} room
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.add = function(id, room, fn){
    debug('adding %s to %s ', id, room);
    Adapter.prototype.add.call(this, id, room);
    var channel = this.prefix + '#' + this.nsp.name + '#' + room + '#';
    sub.subscribe(channel, (err) => {
      if (err) {
        this.emit('error', err);
        if (fn) fn(err);
        return;
      }
      if (fn) fn(null);
    });
  };

  /**
   * Unsubscribe client from room messages.
   *
   * @param {String} session id
   * @param {String} room id
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.del = function(id, room, fn){
    debug('removing %s from %s', id, room);
    
    var hasRoom = Object.keys(this.rooms).includes(room);// this.rooms.hasOwnProperty(room);
    Adapter.prototype.del.call(this, id, room);

    if (hasRoom && !this.rooms[room]) {
      var channel = this.prefix + '#' + this.nsp.name + '#' + room + '#';
      sub.unsubscribe(channel, (err) => {
        if (err) {
          this.emit('error', err);
          if (fn) fn(err);
          return;
        }
        if (fn) fn(null);
      });
    } else {
      if (fn) process.nextTick(fn.bind(null, null));
    }
  };

  /**
   * Unsubscribe client completely.
   *
   * @param {String} client id
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.delAll = function(id, fn){
    debug('removing %s from all rooms', id);

    var rooms = this.sids[id];

    if (!rooms) {
      if (fn) process.nextTick(fn.bind(null, null));
      return;
    }

    Promise.map( Object.keys(rooms), (room) => {
        this.del(id, room, () => {
                    delete this.sids[id];
                    if (fn) fn(null);
                });
    }, { concurrency: Infinity })
    .catch( (err) => {
        this.emit('error', err);
        if (fn) fn(err);
    });

  };

  Redis.uid = uid;
  Redis.pubClient = pub;
  Redis.subClient = sub;
  Redis.prefix = prefix;

  return Redis;

}
