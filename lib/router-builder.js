const CoreObject  = require ('./object');
const assert  = require ('assert');
const debug   = require ('debug')('blueprint:RouterBuilder');
const express = require ('express');
const Policy  = require ('./policy');
const HttpError = require ('./http-error');
const Action  = require ('./action');

const {
  checkSchema,
  validationResult
} = require ('express-validator/check');

const {
  get
} = require ('object-path');

const {
  forOwn,
  isFunction,
  isObjectLike,
  isString,
  flattenDeep,
  isArray,
  extend
} = require ('lodash');

const SINGLE_ACTION_CONTROLLER_METHOD = '__invoke';
const SINGLE_RESOURCE_BASE_PATH = '/:rcId';

/**
 * Factory method that generates an action object.
 */
function makeAction (controller, method, opts) {
  let action = {action: controller + '@' + method};
  return extend (action, opts);
}


function executor (execute) {
  return function __blueprint_execute (req, res, next) {
    try {
      return execute (req, res, function (err) {
        if (!err) return next ();
        return handleError (err, res);
      });
    }
    catch (ex) {
      return handleError (ex, res);
    }
  }
}

/**
 * @class MethodCall
 *
 * Helper class for using reflection to call a method.
 *
 * @param obj
 * @param method
 * @constructor
 */
const MethodCall = CoreObject.extend ({
  invoke () {
    return this.method.apply (this.obj, arguments);
  }
});

module.exports = CoreObject.extend ({
  basePath: '/',

  init () {
    this._super.init.apply (this, arguments);

    assert (!!this.listeners, 'The listener property must be defined');
    assert (!!this.routers, 'The router property must be defined');
    assert (!!this.policies, 'The policies property must be defined');

    this._routers = [];

    Object.defineProperty (this, 'activeRouter', {
      get () {
        return this._routers[this._routers.length - 1];
      }
    });
  },

  build () {
    return new Promise ((resolve, reject) => {
      let router = express.Router ();

      forOwn (this.routers, (definition, name) => {
        // Use the definition to create a child router. Then, bind this router to
        // the base path for the router.
        let childRouter = express.Router ();
        this._routers.push (childRouter);

        this._processRouterSpecification (this.basePath, name, definition);

        router.use (this.basePath, childRouter);
      });

      resolve (router);
    });
  },

  _processRouterSpecification (routerPath, name, spec) {
    debug (`building router ${name} at ${routerPath}`);

    forOwn (spec, (value, key) => {
      switch (key[0])
      {
        case '/':
          this._addRoute (routerPath, key, value);
          break;

        case ':':
          this._addParameter (key, value);
          break;

        default:
          this._processToken (routerPath, key, value);
      }
    });
  },

  _processToken (route, token, value) {
    switch (token) {
      case 'resource':
        this._defineResource (route, value);
        break;

      default:
        this._defineVerb (route, token, value);
        break;
    }
  },

  /**
   * Define a verb on the router for the route.
   * 
   * @param route
   * @param method
   * @param opts
   * @private
   */
  _defineVerb (route, method, opts) {
    debug (`defining ${method.toUpperCase ()} ${route}`);

    let verbFunc = this.activeRouter[method.toLowerCase ()];

    if (!verbFunc)
      throw new Error (`${method} is not a supported http verb`);

    // 1. validate
    // 2. sanitize
    // 3. policies
    // 4a. before
    // 4b. execute
    // 4c. after

    let middleware = [];

    if (isString (opts)) {
      middleware.push (this._actionStringToMiddleware (opts, route));
    }
    else if (isArray (opts)) {
      // Add the array of functions to the middleware.
      middleware.push (opts);
    }
    else {
      // Make sure there is either an action or view defined.
      if (!((opts.action && !opts.view) || (!opts.action && opts.view)))
        throw new Error (`${method} ${route} must define an action or view property`);

      // Add all middleware that should happen before execution. We are going
      // to be deprecating this feature after v4 release.

      if (opts.before)
        middleware.push (opts.before);

      if (opts.action) {
        middleware.push (this._actionStringToMiddleware (opts.action, route, opts));
      }
      else if (opts.view) {
        if (opts.policy)
          middleware.push (this._makePolicyMiddleware (opts.policy));

        middleware.push (render (opts.view));
      }

      // Add all middleware that should happen after execution. We are going
      // to be deprecating this feature after v4 release.
      if (opts.after)
        middleware.push (opts.after);
    }

    // Define the route route. Let's be safe and make sure there is no
    // empty middleware being added to the route.

    if (middleware.length) {
      let stack = flattenDeep (middleware);
      verbFunc.call (this.activeRouter, route, stack);
    }
  },

  _defineResource (route, opts) {
    debug (`defining resource {$route}`);
    throw new Error ('We do not support resource definitions');
  },

  _addRoute (currentPath, route, definition) {
    debug (`adding route ${route} to router at ${currentPath}`);

    let routerPath = currentPath !== '/' ? `${currentPath}${route}` : route;

    this._processRouterSpecification (routerPath, route, definition);
  },

  /**
   * Add a parameter to the active router.
   *
   * @param param
   * @param opts
   * @private
   */
  _addParameter (param, opts) {
    debug (`adding parameter ${param} to router`);

    let handler;

    if (isFunction (opts)) {
      handler = opts;
    }
    else if (isObjectLike (opts)) {
      if (opts.action) {
        // The parameter invokes an operation on the controller.
        let controller = this._resolveControllerAction (opts.action);

        if (!controller)
          throw new Error (`Cannot resolve controller action for parameter [action=${opts.action}]`);

        handler = controller.invoke ();
      }
      else {
        throw new Error (`Invalid parameter specification [param=${param}]`);
      }
    }
    else {
      throw new Error (`Parameter specification must be a Function or CoreObject [param=${param}]`);
    }

    this.activeRouter.param (param.slice (1), handler);
  },

  /**
   * Convert an action string to a express middleware function.
   * 
   * @param action
   * @param path
   * @param opts
   * @returns {Array}
   * @private
   */
  _actionStringToMiddleware (action, path, opts = {}) {
    let middleware = [];

    // Resolve controller and its method. The expected format is controller@method. We are
    // also going to pass params to the controller method.
    let controllerAction = this._resolveControllerAction (action);
    let params = {path};

    if (opts.options)
      params.options = opts.options;

    let result = controllerAction.invoke (params);

    if (isFunction (result) && (result.length === 2 || result.length === 3)) {
      // Let the user know they should migrate the using actions.
      console.warn (`*** deprecated: ${action}: Controller actions should return an Action class, not a function`);

      // Push the function/array onto the middleware stack. If there is a policy,
      // then we need to push that before we push the function onto the middleware
      // stack.
      if (opts.policy)
        middleware.push (this._makePolicyMiddleware (opts.policy));

      middleware.push (result);
    }
    else if (isArray (result)) {
      // Push the function/array onto the middleware stack. If there is a policy,
      // then we need to push that before any of the functions.
      console.warn (`*** deprecated: ${action}: Controller actions should return an Action class, not an array of functions`);

      if (opts.policy)
        middleware.push (this._makePolicyMiddleware (opts.policy));

      middleware.push (result);
    }
    else if (isObjectLike (result) || result.length === 0) {
      if (result.length === 0)
        result = new result (params);
      else
        console.warn (`*** deprecated: ${action}: Controller actions should return an Action class, not an object-like action`);

      // The user elects to have separate validation, sanitize, and execution
      // section for the controller method. There must be a execution function.
      let {validate, sanitize, execute, schema} = result;

      if (!execute)
        throw new Error (`Controller action must define an \'execute\' property [${path}]`);

      // Perform static checks first.

      if (schema) {
        // We have an express-validator schema. The validator and sanitizer should
        // be built into the schema.
        middleware.push (checkSchema (schema));
      }

      // The controller method has the option of validating and sanitizing the
      // input data dynamically. We need to check for either one and add middleware
      // functions if it exists.
      if (validate || sanitize) {
        // The validator can be a f(req) middleware function, an object-like
        // schema, or a array of validator middleware functions.

        if (validate) {
          if (isFunction (validate)) {
            // We either have an legacy validation function, or a middleware function.
            switch (validate.length) {
              case 2:
                console.warn (`*** deprecated: ${action}: validate function must have the signature f(req,res,next)`);
                middleware.push (validator (validate));
                break;

              case 3:
                middleware.push (validate);
                break;

              default:
                throw new Error (`Validate function must have the signature f(req,res,next)`);
            }
          }
          else if (isArray (validate)) {
            // We have a middleware function, or an array of middleware functions.
            middleware.push (validate);
          }
          else if (isObjectLike (validate)) {
            console.warn (`*** deprecated: ${action}: Validation schema must be declared on the 'schema' property`);

            // We have an express-validator schema.
            middleware.push (checkSchema (validate));
          }
          else {
            throw new Error (`validate must be a f(req, res, next), [...f(req, res, next)], or CoreObject-like validation schema [path=${path}]`);
          }
        }

        // The optional sanitize must be a middleware f(req,res,next). Let's add this
        // after the validation operation.
        if (sanitize) {
          console.warn (`*** deprecated: ${action}: Define sanitize operations on the 'validate' or 'schema' property.`);

          if (isFunction (sanitize)) {
            switch (sanitize.length) {
              case 2:
                middleware.push (sanitizer (sanitize));
                break;

              case 3:
                middleware.push (sanitize);
                break;

              default:
                throw new Error (`Sanitize function must have the signature f(req,res,next)`);
            }
          }
          else if (isArray (sanitize)) {
            middleware.push (sanitize);
          }
          else if (isObjectLike (sanitize)) {
            // We have an express-validator schema.
            middleware.push (checkSchema (validate));
          }
        }
      }

      // Push the middleware that will evaluate the validation result. If the
      // validation fails, then this middleware will stop the request's progress.
      if (validate || sanitize || schema)
        middleware.push (handleValidationResult);

      // The request is validated and the data has been sanitized. We can now work
      // on the actual data in the request. Let's check the policies for the request
      // and then execute it.
      let {policy} = opts;

      if (policy)
        middleware.push (this._makePolicyMiddleware (policy));

      // Lastly, push the execution function onto the middleware stack. If the
      // execute takes 2 parameters, we are going to assume it returns a Promise.
      // Otherwise, it is a middleware function.
      switch (execute.length)
      {
        case 2:
          // The execute method is returning a Promise.
          middleware.push (executePromise (execute));
          break;

        case 3:
          // The execute method is a middleware function.
          middleware.push (execute);
          break;
      }
    }
    else {
      throw new Error (`Controller action expected to return a Function, CoreObject, or an Action`);
    }

    return flattenDeep (middleware);
  },

  /**
   * Resolve a controller from an action specification.
   *
   * @param action
   * @private
   */
  _resolveControllerAction (action) {
    let [controllerName, actionName] = action.split ('@');

    if (!controllerName)
      throw new Error (`The action must include a controller name [${action}]`);

    if (!actionName)
      actionName = SINGLE_ACTION_CONTROLLER_METHOD;

    // Locate the controller object in our loaded controllers. If the controller
    // does not exist, then throw an exception.
    let controller = get (this.controllers, controllerName);

    if (!controller)
      throw new Error (`${controllerName} not found`);

    // Locate the action method on the loaded controller. If the method does
    // not exist, then throw an exception.
    let method = controller[actionName];

    if (!method)
      throw new Error (`${controllerName} does not define method ${actionName}`);

    return new MethodCall ({ obj: controller, method });
  },

  /**
   * Make a policy middleware from the options.
   *
   * @param opts
   * @private
   */
  _makePolicyMiddleware (opts) {
    let middleware = [];

    if (isString (opts)) {
      // The options is the name of the policy. Look up the policy and use it.
      const policy = this._createPolicyFromName (opts);

      if (policy)
        middleware.push (applyPolicy (opts, policy));
    }
    else if (isArray (opts)) {
      const [name, ...params] = opts;
      const policy = this._createPolicyFromName (name);

      if (policy)
        middleware.push (applyPolicy (name, policy, params));
    }
    else {
      throw new Error ('The policy specification must be a String or an Array')
    }

    return middleware;
  },

  /**
   * Create a policy from a name.
   *
   * @param name
   * @returns {*}
   * @private
   */
  _createPolicyFromName (name) {
    const optional = name[0] === '?';
    const policyName = optional ? name.slice (1) : name;

    const Policy = get (this.policies, policyName);

    if (optional && !Policy)
      return null;

    assert (Policy, `Policy ${policyName} does not exist.`);

    return new Policy ();
  }
});

/**
 * Handle the validation results.
 *
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
function handleValidationResult (req, res, next) {
  const errors = validationResult (req);

  if (errors.isEmpty ())
    return next ();

  let err = new HttpError (400, 'validation_failed', 'Request validation failed.', {validation: errors.mapped ()});
  return next (err);
}

/**
 * Factory method for creating a policy middleware for a request.
 *
 * @param name            Name of policy for reporting
 * @param policy          A Policy object
 * @param params          Optional parameters for the policy
 * @returns {Function}
 */
function applyPolicy (name, policy, params = []) {
  return function __blueprint_policy (req, res, next) {
    // Initialize an empty policy errors container for the request. This
    // is needed for legacy purposes.

    if (!req._policyErrors || !isArray (req._policyErrors))
      req._policyErrors = [];

    policy.runCheck (req, ...params).then (result => {
      if (result === true)
        return next ();

      if (result === false) {
        // The policy result was a boolean value. This means that we are to use
        // the default failure code and message as the policy error.
        let {failureCode,failureMessage} = policy;
        return next (new HttpError (403, failureCode, failureMessage));
      }
      else if (isObjectLike (result)) {
        // The result is an object. This means we are to use the result
        // as-is for the policy error.
        let {failureCode,failureMessage} = result;
        return next (new HttpError (403, failureCode, failureMessage));
      }
      else {
        console.error (`The policy ${name} returned a bad result`);
        return next (new HttpError (500, 'bad_result', 'The policy returned a bad result.'));
      }
    }).catch (next);
  };
}

/**
 * Factory method for creating a middleware function for the execute
 * function that returns a Promise.
 *
 * @param execute         Execute method that returns a promise.
 * @returns {Function}
 */
function executePromise (execute) {
  return function __blueprint_execute (req, res, next) {
    execute (req, res).then (() => {
      next ();
    }).catch (next);
  }
}

/**
 * Factory method for creating the validate middleware function.
 *
 * @param validate
 * @returns {__blueprint_validate}
 */
function validator (validate) {
  return function __blueprint_validate (req, res, next) {
    validate (req, next);
  }
}

function sanitizer (sanitize) {
  return function __blueprint_sanitize (req, res, next) {
    sanitize (req, next);
  }
}

/**
 * Factory method that generates a middleware function for rendering a static
 * view to a request.
 *
 * @param view
 * @returns {Function}
 */
function render (view) {
  return function __blueprint_render (req, res, next) {
    res.render (view);
    next ();
  };
}