import 'mocha';
import should = require('should');
import { add, Calculator } from '../src';
import CalcZ from '../src/calculator';
import { ReexportedCalculator } from '../src/reexported';

describe('First test', () => {
    it('function', () => {
        should(add(4, 5)).be.equal(9);
    });

    it('class', () => {
        const calc = new CalcZ();
        should(calc.multiply(4, 5)).be.equal(20);
    });

    it('class-2', () => {
        const calc = new Calculator();
        should(calc.multiply(4, 5)).be.equal(20);
    });

    it('class-3', () => {
        const calc = new ReexportedCalculator();
        should(calc.multiply(4, 5)).be.equal(20);
    });
});
