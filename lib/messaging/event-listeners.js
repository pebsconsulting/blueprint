const Object = require ('../object');
const assert = require ('assert');
const ListenerHandle = require ('./listener-handle');
const Listener = require ('./listener');
const LegacyListener = require ('./legacy-listener');

/**
 * Wrapper class for a set of listeners for an event.
 */
module.exports = Object.extend ({
  /// Name of the event the listeners handle.
  name: null,

  init () {
    this._super.call (this, ...arguments);

    assert (this.name, 'Missing name property');

    this._on = [];
    this._once = [];
  },

  /**
   * Register a new listener for the event.
   *
   * @param listener
   */
  on (listener) {
    if (!(listener instanceof Listener))
      listener = new LegacyListener ({listener});

    const index = this._on.push (listener) - 1;
    return new ListenerHandle ({listeners: this, index});
  },

  /**
   * Register a listener that is only called once. Once the listener is executed,
   * it will be removed from the registry.
   *
   * @param listener
   */
  once (listener) {
    if (!(listener instanceof Listener))
      listener = new LegacyListener ({listener});

    this._once.push (listener);
  },

  /**
   * Emit a new event. The order the event is emitted to the registered listeners
   * is non-deterministic.
   */
  emit () {
    // Make a copy of the once array, and erase it contents.
    let once = this._once;
    this._once = [];

    // The listeners have the option of returning a Promise if they want to allow
    // the client to wait until the event handling is complete. We therefore need
    // to account for this possibility. This does not mean the client that emits
    // the event will be synchronous. The client just has the option of waiting
    // until the event has been emitted to all listeners.

    let pending = [];

    for (let i = 0, len = this._on.length; i < len; ++ i)
      pending.push (this._on[i].handleEvent (...arguments));

    for (let i = 0, len = once.length; i < len; ++ i)
      pending.push (once[i].handleEvent (...arguments));

    return Promise.all (pending);
  },

  /**
   * Remove the listener at the specified index.
   *
   * @param index
   */
  removeListenerAt (index) {
    this._on.splice (index, 1);
  }
});

