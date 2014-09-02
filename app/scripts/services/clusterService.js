'use strict';

require('../app');
var angular = require('angular');

angular.module('deckApp')
  .factory('clusterService', function (searchService, settings, $q, Restangular, _, loadBalancerService) {

    var oortEndpoint = Restangular.withConfig(function (RestangularConfigurer) {
      RestangularConfigurer.setBaseUrl(settings.oortUrl);
    });

    function getApplicationEndpoint(application) {
      return oortEndpoint.one('applications', application);
    }

    function getClustersForAccountEndpoint(application, account) {
      return getApplicationEndpoint(application).all('clusters').all(account);
    }

    function loadClusters(application) {
      var clusterPromises = [];

      application.accounts.forEach(function (account) {
        var accountClusters = application.clusters[account];
        accountClusters.forEach(function (cluster) {
          var clusterPromise = getCluster(application, account, cluster.name);
          clusterPromises.push(clusterPromise);
        });
      });

      return $q.all(clusterPromises);
    }

    function getCluster(application, account, clusterName) {
      return getClustersForAccountEndpoint(application.name, account).all(clusterName).getList().then(function(cluster) {
        if (!cluster.length) {
          console.error('NO SERVER GROUPS', cluster); // TODO: remove when https://github.com/spinnaker/oort/issues/35 resolved
          return {
            account: account,
            serverGroups: []
          };
        }
        cluster[0].serverGroups.forEach(function(serverGroup) {
          normalizeServerGroup(serverGroup, account, clusterName);
        });
        cluster[0].account = account;
        addHealthCountsToCluster(cluster[0]);
        return cluster[0];
      });
    }

    function addHealthCountsToCluster(cluster) {
      cluster.upCount = 0;
      cluster.downCount = 0;
      cluster.unknownCount = 0;
      if (!cluster.serverGroups) {
        return;
      }
      cluster.serverGroups.forEach(function(serverGroup) {
        cluster.upCount += serverGroup.upCount;
        cluster.downCount += serverGroup.downCount;
        cluster.unknownCount += serverGroup.unknownCount;
      });
    }

    function addInstancesOnlyFoundInAsg(serverGroup) {
      var foundIds = serverGroup.instances.map(function (instance) {
        return instance.instanceId;
      });
      var rejected = serverGroup.asg.instances.filter(function (asgInstance) {
        return foundIds.indexOf(asgInstance.instanceId) === -1;
      });
      rejected.forEach(function(rejected) {
        rejected.serverGroup = serverGroup.name;
      });
      serverGroup.instances = serverGroup.instances.concat(rejected);
    }

    function addHealthyCountsToServerGroup(serverGroup) {
      serverGroup.upCount = _.filter(serverGroup.instances, {healthStatus: 'Healthy'}).length;
      serverGroup.downCount = _.filter(serverGroup.instances, {healthStatus: 'Unhealthy'}).length;
      serverGroup.unknownCount = _.filter(serverGroup.instances, {healthStatus: 'Unknown'}).length;
    }

    function normalizeInstances(serverGroup) {
      if (serverGroup.instances && serverGroup.instances.length) {
        serverGroup.instances.forEach(function (instance) {
          var asgInstance = serverGroup.asg.instances.filter(function (asgInstance) {
            return asgInstance.instanceId === instance.instanceId;
          })[0];
          instance.region = serverGroup.region;
          angular.extend(instance, asgInstance);
        });
      }
    }

    function updateLoadBalancers(application) {
      application.getServerGroups().forEach(function(serverGroup) {
        serverGroup.loadBalancers = application.loadBalancers.filter(function(loadBalancer) {
          return loadBalancerService.serverGroupIsInLoadBalancer(serverGroup, loadBalancer);
        });
      });
    }

    function normalizeServerGroupsWithLoadBalancers(application) {
      updateLoadBalancers(application);
    }

    function normalizeServerGroup(serverGroup, accountName, clusterName) {
      var suspendedProcesses = _.collect(serverGroup.asg.suspendedProcesses, 'processName'),
        disabledProcessFlags = ['AddToLoadBalancer', 'Launch', 'Terminate'];

      serverGroup.instances = serverGroup.instances.map(function(instance) {
        var toReturn = instance.instance;
        toReturn.account = accountName;
        return toReturn;
      });
      serverGroup.account = accountName;
      serverGroup.cluster = clusterName;
      serverGroup.isDisabled = _.intersection(disabledProcessFlags, suspendedProcesses).length === disabledProcessFlags.length;
      normalizeInstances(serverGroup);
      addInstancesOnlyFoundInAsg(serverGroup);
      addHealthyCountsToServerGroup(serverGroup);
    }

    return {
      loadClusters: loadClusters,
      normalizeServerGroupsWithLoadBalancers: normalizeServerGroupsWithLoadBalancers
    };

  });
