import {TestContextFactory} from "../lib/TestContext";
import {TestModuleDependencies} from "./TestModule";

type ExternalDependencies = {}

type Config = {}

describe('TestContext', () => {
    it('bootstraps given module', () => {
        const testContextFactory = new TestContextFactory<TestModuleDependencies, ExternalDependencies, Config>({}, {}, )
    })
})
