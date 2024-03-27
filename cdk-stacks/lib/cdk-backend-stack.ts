// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {CfnOutput, Stack, StackProps, Duration, RemovalPolicy, Size} from "aws-cdk-lib";
import {Construct} from "constructs";
import {Runtime} from "aws-cdk-lib/aws-lambda";
import * as firehose from "@aws-cdk/aws-kinesisfirehose-alpha";
import * as destinations from "@aws-cdk/aws-kinesisfirehose-destinations-alpha";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from 'aws-cdk-lib/aws-iam';
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';
import { NagSuppressions } from 'cdk-nag'
import * as S3 from "aws-cdk-lib/aws-s3";
import * as S3Deployment from "aws-cdk-lib/aws-s3-deployment";
import * as logs from "aws-cdk-lib/aws-logs"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import path = require('path');

const configParams = require('../config.params.json');

export class CdkBackendStack extends Stack {

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'This is the default Lambda Execution Policy which just grants writes to CloudWatch.'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the pythong version it deploys'
      },{
        id: 'AwsSolutions-IAM5',
        reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the policy it builds.  This is only used to deploy static files and these templates are only used internally to generate sample test data.'
      }
    ])

    const ssmParams = loadSSMParams(this);

    // Templates Bucket
    const templatesBucket = new S3.Bucket(this, "templatesBucket", {
      objectOwnership: S3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: S3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: S3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true
    });

    NagSuppressions.addResourceSuppressions(templatesBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is a bucket to store template data and will not be accessed by the public.  These templates are used to create test AppFabric logs and will not be used for production work.'
      },
  ])

    // Transformed Logs Bucket
    const logsBucket = new S3.Bucket(this, "logsBucket", {
      objectOwnership: S3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: S3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true, 
      enforceSSL: true,
      blockPublicAccess: S3.BlockPublicAccess.BLOCK_ALL,
    });

    NagSuppressions.addResourceSuppressions(logsBucket, [
        {
          id: 'AwsSolutions-S1',
          reason: 'This is a bucket to store transformed log data and will not be accessed by the public.'
        },
    ])

    const bucketDeployment = new S3Deployment.BucketDeployment(this, "Deployment", {
      sources: [S3Deployment.Source.asset('lib/templates/')],
      destinationBucket: templatesBucket,
    });

    //Custom Log Group so we can add Metric Filters
    const logGroup = new logs.LogGroup(this, 'LogTransformerLambdaLogGroup',{
      retention: logs.RetentionDays.THREE_MONTHS
    });

    const metricFilter = new logs.MetricFilter(this, 'MetricFilter', {
      logGroup,
      metricNamespace: 'AppFabricTransformer',
      metricName: 'Transform Errors',
      filterPattern: logs.FilterPattern.literal('{ $.level = "ERROR" }'),
      metricValue: "1",
      unit: cloudwatch.Unit.COUNT
    });

    const metric = new cloudwatch.Metric({
      namespace: 'AppFabricTransformer',
      metricName: 'Transform Errors'
  })

    const alarm = new cloudwatch.Alarm(this, 'LogTransformerLambdaErrors', {
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 1,
      metric: metric,
    });

    const logTransformerLambda = new nodeLambda.NodejsFunction(this, 'LogTransformerLambda', {
      runtime: Runtime.NODEJS_18_X,
      description: "App Fabric Log Transformer. Created By CDK AppFabric Solution. DO NOT EDIT",
      entry: path.join(__dirname, 'lambdas/handlers/node/logtransformer.mjs'),
      memorySize: 1028,
      timeout: Duration.seconds(300),
      logFormat: 'JSON',
      applicationLogLevel: 'INFO',
      logGroup: logGroup,
      environment: { 
        APPLICATION_VERSION: `v${this.node.tryGetContext('application_version')} (${new Date().toISOString()})`,
        TEMPLATES_BUCKET: templatesBucket.bucketName,
        DEFAULT_TEMPLATE: 'ocsf_to_ecs.vm',
        CACHE_EXPIRATION_SECONDS: '300'
      }
    });
    
    const statements = [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [  
          "s3:PutObject",         
          "s3:GetObject",
          "s3:ListBucket"
        ],
        resources: [
          templatesBucket.bucketArn,
          `${templatesBucket.bucketArn}/*`
        ]
      })
    ];
    //Policy for Lambda
    logTransformerLambda.role?.attachInlinePolicy(new iam.Policy(this, 'logGeneratorLambdaPolicy', {
        statements
    }));

    const lambdaProcessor = new firehose.LambdaFunctionProcessor(logTransformerLambda, {
      bufferInterval: Duration.minutes(1),
      bufferSize: Size.mebibytes(1),
      retries: 3,
    });

    const s3Destination = new destinations.S3Bucket(logsBucket, {
      dataOutputPrefix: 'transformed-logs',
      errorOutputPrefix: 'transform-errors',
      bufferingInterval: Duration.minutes(1),
      bufferingSize: Size.mebibytes(1),
      processor: lambdaProcessor,
      // s3Backup: {
      //   mode: destinations.BackupMode.FAILED,
      //   dataOutputPrefix: 'transform-errored-files',
      // },
    });

    const firehoseStream = new firehose.DeliveryStream(this, 'Delivery Stream', {
      encryption: firehose.StreamEncryption.AWS_OWNED,
      destinations: [s3Destination],
    });

    /**************************************************************************************************************
      * CDK Outputs *
    **************************************************************************************************************/

    new CfnOutput(this, "TemplatesBucketName", {
      value: templatesBucket.bucketName,
    });

    new CfnOutput(this, "logTransformerLambdaName", {
      value: logTransformerLambda.functionName
    });

    new CfnOutput(this, "logTransformerLambdaARN", {
      value: logTransformerLambda.functionArn
    });

    new CfnOutput(this, "logTransformerCloudWatchLogGroup", {
      value: logGroup.logGroupName
    });

    new CfnOutput(this, "logTransformerCloudWatchAlarm", {
      value: alarm.alarmName
    });

    new CfnOutput(this, "logDestinationS3Bucket", {
      value: logsBucket.bucketName
    });

    new CfnOutput(this, "logTransformerFirehoseStreamARN", {
      value: firehoseStream.deliveryStreamArn
    });

  }
}